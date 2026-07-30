"""
Offline training script for predictive maintenance models.

This script:
1. Loads the aircraft maintenance dataset
2. Engineers features
3. Creates labels
4. Trains classification and regression models
5. Evaluates them
6. Saves model artifacts for production inference

Run example:
    python -m src.aircraft_maintenance.train_model
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.metrics import (
    accuracy_score,
    balanced_accuracy_score,
    classification_report,
    confusion_matrix,
    explained_variance_score,
    f1_score,
    mean_absolute_error,
    mean_squared_error,
    precision_score,
    r2_score,
    recall_score,
    roc_auc_score,
)
from sklearn.pipeline import Pipeline

try:
    from xgboost import XGBClassifier, XGBRegressor

    XGBOOST_AVAILABLE = True
except Exception:
    XGBOOST_AVAILABLE = False


logger = logging.getLogger(__name__)


COLUMN_ALIASES = {
    "aircraftid": "Aircraft_ID",
    "aircraft": "Aircraft_ID",
    "tailnumber": "Aircraft_ID",
    "tailno": "Aircraft_ID",
    "flightcycle": "Flight_Cycle",
    "flightcycles": "Flight_Cycle",
    "cycle": "Flight_Cycle",
    "cycles": "Flight_Cycle",
    "flightnumber": "Flight_Cycle",
    "flightno": "Flight_Cycle",
    "egt": "Engine_Exhaust_Gas_Temperature",
    "engineexhaustgastemperature": "Engine_Exhaust_Gas_Temperature",
    "cabintemperature": "Cabin_Temperature",
    "fuelflow": "Fuel_Flow",
    "oilpressure": "Oil_Pressure",
    "enginerpm": "Engine_RPM",
    "humidity": "Humidity",
    "landingspeed": "Landing_Speed",
    "windspeed": "Wind_Speed",
    "altitude": "Altitude",
    "turbinevibration": "Turbine_Vibration",
    "enginevibration": "Turbine_Vibration",
    "hydraulicpressure": "Hydraulic_Pressure",
    "braketemperature": "Brake_Temperature",
    "detectedfailuremode": "Detected_Failure_Mode",
    "recommendedmaintenanceaction": "Recommended_Maintenance_Action",
    "maintenancestatus": "Maintenance_Status",
    "remainingusefullife": "Remaining_Useful_Life",
    "riskscore": "Risk_Score",
}

RAW_FEATURE_COLUMNS = [
    "Engine_Exhaust_Gas_Temperature",
    "Cabin_Temperature",
    "Fuel_Flow",
    "Oil_Pressure",
    "Engine_RPM",
    "Humidity",
    "Landing_Speed",
    "Wind_Speed",
    "Altitude",
    "Turbine_Vibration",
    "Hydraulic_Pressure",
    "Brake_Temperature",
]


@dataclass
class TrainingBundle:
    classification_model_path: str
    regression_model_path: str
    metadata_path: str
    metrics_path: str


class PredictiveMaintenanceTrainer:
    def __init__(
        self,
        excel_path: str | Path,
        sheet_name: str | int = 0,
        failure_horizon: int = 20,
        model_dir: str | Path = "./models",
    ) -> None:
        self.excel_path = Path(excel_path)
        self.sheet_name = sheet_name
        self.failure_horizon = failure_horizon
        self.model_dir = Path(model_dir)

        self.data: pd.DataFrame | None = None
        self.model_data: pd.DataFrame | None = None

    def load_dataset(self) -> pd.DataFrame:
        if not self.excel_path.exists():
            raise FileNotFoundError(f"Dataset not found: {self.excel_path}")

        data = pd.read_excel(self.excel_path, sheet_name=self.sheet_name)
        data = self._clean_columns(data)
        self._validate_required_columns(data)

        data["Aircraft_ID"] = data["Aircraft_ID"].astype(str)
        data["Flight_Cycle"] = pd.to_numeric(data["Flight_Cycle"], errors="coerce")
        data = data.dropna(subset=["Aircraft_ID", "Flight_Cycle"])
        data["Flight_Cycle"] = data["Flight_Cycle"].astype(int)

        for column in RAW_FEATURE_COLUMNS:
            if column in data.columns:
                data[column] = pd.to_numeric(data[column], errors="coerce")

        self.data = data.sort_values(["Aircraft_ID", "Flight_Cycle"]).reset_index(drop=True)
        return self.data

    def prepare_training_data(self) -> pd.DataFrame:
        data = self._require_data().copy()
        available_raw_features = [c for c in RAW_FEATURE_COLUMNS if c in data.columns]

        if not available_raw_features:
            raise ValueError("None of the expected raw feature columns were found.")

        grouped = data.groupby("Aircraft_ID", group_keys=False)

        for col in available_raw_features:
            data[f"{col}_lag_1"] = grouped[col].shift(1)
            data[f"{col}_lag_2"] = grouped[col].shift(2)
            data[f"{col}_lag_3"] = grouped[col].shift(3)

            data[f"{col}_delta_1"] = data[col] - data[f"{col}_lag_1"]
            data[f"{col}_delta_2"] = data[col] - data[f"{col}_lag_2"]

            data[f"{col}_roll_mean_3"] = grouped[col].transform(
                lambda s: s.shift(1).rolling(3, min_periods=1).mean()
            )
            data[f"{col}_roll_std_3"] = grouped[col].transform(
                lambda s: s.shift(1).rolling(3, min_periods=1).std()
            )
            data[f"{col}_roll_mean_5"] = grouped[col].transform(
                lambda s: s.shift(1).rolling(5, min_periods=1).mean()
            )
            data[f"{col}_roll_std_5"] = grouped[col].transform(
                lambda s: s.shift(1).rolling(5, min_periods=1).std()
            )

            std_col = f"{col}_roll_std_5"
            mean_col = f"{col}_roll_mean_5"
            data[f"{col}_zscore_5"] = np.where(
                (data[std_col].notna()) & (data[std_col] != 0),
                (data[col] - data[mean_col]) / data[std_col],
                0.0,
            )

            data[f"{col}_slope_5"] = grouped[col].transform(self._rolling_slope_shifted)

        data["Aircraft_Age_In_Cycles"] = grouped.cumcount() + 1

        self._safe_create_ratio(data, "Engine_Exhaust_Gas_Temperature", "Fuel_Flow", "EGT_to_FuelFlow")
        self._safe_create_ratio(data, "Oil_Pressure", "Engine_RPM", "OilPressure_to_RPM")
        self._safe_create_product(data, "Turbine_Vibration", "Engine_RPM", "Vibration_x_RPM")
        self._safe_create_ratio(data, "Brake_Temperature", "Landing_Speed", "BrakeTemp_to_LandingSpeed")

        data["Failure_Event"] = self._derive_failure_event(data)
        data["Failure_Within_Horizon"] = (
            grouped["Failure_Event"]
            .transform(lambda s: self._future_failure_within_horizon(s, self.failure_horizon))
            .astype(int)
        )
        data["RUL_Target"] = grouped["Failure_Event"].transform(self._compute_rul)

        feature_columns = self._get_feature_columns(data)
        data = data.dropna(subset=["RUL_Target"], how="all").copy()
        rows_with_any_signal = data[feature_columns].notna().sum(axis=1) > 0
        data = data[rows_with_any_signal].reset_index(drop=True)

        logger.info("Failure_Event distribution: %s", data["Failure_Event"].value_counts(dropna=False).to_dict())
        logger.info(
            "Failure_Within_Horizon distribution: %s",
            data["Failure_Within_Horizon"].value_counts(dropna=False).to_dict(),
        )

        self.model_data = data
        return self.model_data

    def train_and_save(self) -> TrainingBundle:
        data = self._require_model_data().copy()
        feature_columns = self._get_feature_columns(data)

        clf_data = data.dropna(subset=["Failure_Within_Horizon"]).copy()
        reg_data = data.dropna(subset=["RUL_Target"]).copy()

        if clf_data.empty:
            raise ValueError("No rows available for classification training.")
        if reg_data.empty:
            raise ValueError("No rows available for regression training.")

        clf_train, clf_test = self._time_based_split(clf_data)
        reg_train, reg_test = self._time_based_split(reg_data)

        X_train_clf = clf_train[feature_columns]
        y_train_clf = clf_train["Failure_Within_Horizon"]
        X_test_clf = clf_test[feature_columns]
        y_test_clf = clf_test["Failure_Within_Horizon"]

        X_train_reg = reg_train[feature_columns]
        y_train_reg = reg_train["RUL_Target"]
        X_test_reg = reg_test[feature_columns]
        y_test_reg = reg_test["RUL_Target"]

        logger.info("Classification train class distribution: %s", y_train_clf.value_counts().to_dict())
        logger.info("Classification test class distribution: %s", y_test_clf.value_counts().to_dict())

        classification_model = self._build_classifier(y_train_clf)
        regression_model = self._build_regressor()

        classification_model.fit(X_train_clf, y_train_clf)
        regression_model.fit(X_train_reg, y_train_reg)

        clf_prob = self._predict_proba_safe(classification_model, X_test_clf)
        clf_pred = (clf_prob >= 0.5).astype(int)

        reg_pred = regression_model.predict(X_test_reg)
        mse_value = float(mean_squared_error(y_test_reg, reg_pred))

        classification_metrics = {
            "accuracy": float(accuracy_score(y_test_clf, clf_pred)),
            "balanced_accuracy": float(balanced_accuracy_score(y_test_clf, clf_pred))
            if y_test_clf.nunique() > 1 else None,
            "precision": float(precision_score(y_test_clf, clf_pred, zero_division=0)),
            "recall": float(recall_score(y_test_clf, clf_pred, zero_division=0)),
            "f1_score": float(f1_score(y_test_clf, clf_pred, zero_division=0)),
            "roc_auc": self._safe_roc_auc(y_test_clf, clf_prob),
            "train_class_distribution": y_train_clf.value_counts().to_dict(),
            "test_class_distribution": y_test_clf.value_counts().to_dict(),
            "classification_report": classification_report(
                y_test_clf, clf_pred, output_dict=True, zero_division=0
            ),
            "confusion_matrix": confusion_matrix(y_test_clf, clf_pred).tolist(),
            "test_size": int(len(clf_test)),
            "train_size": int(len(clf_train)),
        }

        regression_metrics = {
            "mae": float(mean_absolute_error(y_test_reg, reg_pred)),
            "mse": mse_value,
            "rmse": float(math.sqrt(mse_value)),
            "r2_score": float(r2_score(y_test_reg, reg_pred)) if len(y_test_reg) > 1 else None,
            "explained_variance": float(explained_variance_score(y_test_reg, reg_pred))
            if len(y_test_reg) > 1 else None,
            "test_size": int(len(reg_test)),
            "train_size": int(len(reg_train)),
        }

        self.model_dir.mkdir(parents=True, exist_ok=True)

        classifier_path = self.model_dir / "predictive_classifier.joblib"
        regressor_path = self.model_dir / "predictive_regressor.joblib"
        metadata_path = self.model_dir / "predictive_metadata.json"
        metrics_path = self.model_dir / "predictive_metrics.json"

        joblib.dump(classification_model, classifier_path)
        joblib.dump(regression_model, regressor_path)

        metadata = {
            "feature_columns": feature_columns,
            "failure_horizon": self.failure_horizon,
            "sheet_name": self.sheet_name,
            "raw_feature_columns": RAW_FEATURE_COLUMNS,
            "model_type_classifier": type(classification_model.named_steps["model"]).__name__,
            "model_type_regressor": type(regression_model.named_steps["model"]).__name__,
            "training_dataset": str(self.excel_path),
        }

        metrics = {
            "classification_metrics": classification_metrics,
            "regression_metrics": regression_metrics,
        }

        metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        metrics_path.write_text(json.dumps(metrics, indent=2), encoding="utf-8")

        logger.info("Saved classifier to %s", classifier_path)
        logger.info("Saved regressor to %s", regressor_path)
        logger.info("Saved metadata to %s", metadata_path)
        logger.info("Saved metrics to %s", metrics_path)

        return TrainingBundle(
            classification_model_path=str(classifier_path),
            regression_model_path=str(regressor_path),
            metadata_path=str(metadata_path),
            metrics_path=str(metrics_path),
        )

    @staticmethod
    def _clean_columns(data: pd.DataFrame) -> pd.DataFrame:
        data = data.copy()
        cleaned_columns = []

        for column in data.columns:
            column_name = str(column).strip()
            column_without_units = re.sub(r"\s*\([^)]*\)", "", column_name).strip()
            normalized_key = re.sub(r"[^a-z0-9]+", "", column_without_units.lower())

            if normalized_key in COLUMN_ALIASES:
                cleaned_columns.append(COLUMN_ALIASES[normalized_key])
            else:
                cleaned_columns.append(
                    re.sub(r"[^A-Za-z0-9]+", "_", column_without_units).strip("_")
                )

        data.columns = cleaned_columns
        return data

    @staticmethod
    def _validate_required_columns(data: pd.DataFrame) -> None:
        required = {"Aircraft_ID", "Flight_Cycle"}
        missing = required.difference(data.columns)
        if missing:
            raise ValueError(
                f"Missing required columns: {sorted(missing)}. "
                f"Available columns: {list(data.columns)}"
            )

    def _require_data(self) -> pd.DataFrame:
        if self.data is None:
            return self.load_dataset()
        return self.data

    def _require_model_data(self) -> pd.DataFrame:
        if self.model_data is None:
            return self.prepare_training_data()
        return self.model_data

    @staticmethod
    def _rolling_slope_shifted(series: pd.Series) -> pd.Series:
        shifted = series.shift(1)

        def slope(window: pd.Series) -> float:
            arr = window.dropna().values
            if len(arr) < 2:
                return np.nan
            x = np.arange(len(arr))
            coeffs = np.polyfit(x, arr, 1)
            return float(coeffs[0])

        return shifted.rolling(5, min_periods=2).apply(slope, raw=False)

    @staticmethod
    def _safe_create_ratio(data: pd.DataFrame, num: str, den: str, out: str) -> None:
        if num in data.columns and den in data.columns:
            data[out] = np.where(
                data[den].notna() & (data[den] != 0),
                data[num] / data[den],
                np.nan,
            )

    @staticmethod
    def _safe_create_product(data: pd.DataFrame, a: str, b: str, out: str) -> None:
        if a in data.columns and b in data.columns:
            data[out] = data[a] * data[b]

    @staticmethod
    def _derive_failure_event(data: pd.DataFrame) -> pd.Series:
        failure = pd.Series(0, index=data.index, dtype=int)

        if "Detected_Failure_Mode" in data.columns:
            failure = failure | (
                data["Detected_Failure_Mode"].fillna("").astype(str).str.strip().ne("")
            )

        if "Recommended_Maintenance_Action" in data.columns:
            failure = failure | (
                data["Recommended_Maintenance_Action"].fillna("").astype(str).str.strip().ne("")
            )

        if "Maintenance_Status" in data.columns:
            status = data["Maintenance_Status"].fillna("").astype(str).str.lower().str.strip()
            failure = failure | status.str.contains(
                "critical|required|immediate|fault|failed|failure|replace|inspection",
                regex=True,
                na=False,
            )

        return failure.astype(int)

    @staticmethod
    def _future_failure_within_horizon(series: pd.Series, horizon: int) -> pd.Series:
        values = series.fillna(0).astype(int).values
        result = np.zeros(len(values), dtype=int)

        for i in range(len(values)):
            future_end = min(len(values), i + horizon + 1)
            if values[i + 1 : future_end].sum() > 0:
                result[i] = 1

        return pd.Series(result, index=series.index)

    @staticmethod
    def _compute_rul(series: pd.Series) -> pd.Series:
        values = series.fillna(0).astype(int).values
        result = np.full(len(values), np.nan)

        future_failure_indices = np.where(values == 1)[0]
        for i in range(len(values)):
            future = future_failure_indices[future_failure_indices >= i]
            if len(future) == 0:
                result[i] = np.nan
            else:
                result[i] = float(future[0] - i)

        return pd.Series(result, index=series.index)

    @staticmethod
    def _time_based_split(
        data: pd.DataFrame,
        train_ratio: float = 0.8,
    ) -> tuple[pd.DataFrame, pd.DataFrame]:
        train_parts = []
        test_parts = []

        for _, group in data.groupby("Aircraft_ID"):
            group = group.sort_values("Flight_Cycle").reset_index(drop=True)
            split_idx = max(1, int(len(group) * train_ratio))
            train_parts.append(group.iloc[:split_idx])
            if split_idx < len(group):
                test_parts.append(group.iloc[split_idx:])

        train_df = pd.concat(train_parts, ignore_index=True) if train_parts else pd.DataFrame(columns=data.columns)
        test_df = pd.concat(test_parts, ignore_index=True) if test_parts else pd.DataFrame(columns=data.columns)

        if test_df.empty:
            split_idx = max(1, int(len(data) * train_ratio))
            data = data.sort_values(["Aircraft_ID", "Flight_Cycle"]).reset_index(drop=True)
            train_df = data.iloc[:split_idx].copy()
            test_df = data.iloc[split_idx:].copy()

        return train_df, test_df

    @staticmethod
    def _get_feature_columns(data: pd.DataFrame) -> list[str]:
        exclude = {
            "Aircraft_ID",
            "Flight_Cycle",
            "Failure_Event",
            "Failure_Within_Horizon",
            "RUL_Target",
            "Detected_Failure_Mode",
            "Recommended_Maintenance_Action",
            "Maintenance_Status",
        }

        feature_columns = [
            c
            for c in data.columns
            if c not in exclude and pd.api.types.is_numeric_dtype(data[c])
        ]

        if not feature_columns:
            raise ValueError("No numeric feature columns available for training.")

        return feature_columns

    def _build_classifier(self, y_train_clf: pd.Series) -> Pipeline:
        if XGBOOST_AVAILABLE and y_train_clf.nunique() >= 2:
            model = XGBClassifier(
                n_estimators=250,
                max_depth=6,
                learning_rate=0.05,
                subsample=0.9,
                colsample_bytree=0.9,
                random_state=42,
                eval_metric="logloss",
            )
        else:
            model = RandomForestClassifier(
                n_estimators=250,
                max_depth=10,
                random_state=42,
                n_jobs=-1,
                class_weight="balanced" if y_train_clf.nunique() >= 2 else None,
            )

        return Pipeline(
            steps=[
                ("imputer", SimpleImputer(strategy="median")),
                ("model", model),
            ]
        )

    def _build_regressor(self) -> Pipeline:
        if XGBOOST_AVAILABLE:
            model = XGBRegressor(
                n_estimators=250,
                max_depth=6,
                learning_rate=0.05,
                subsample=0.9,
                colsample_bytree=0.9,
                random_state=42,
            )
        else:
            model = RandomForestRegressor(
                n_estimators=250,
                max_depth=10,
                random_state=42,
                n_jobs=-1,
            )

        return Pipeline(
            steps=[
                ("imputer", SimpleImputer(strategy="median")),
                ("model", model),
            ]
        )

    @staticmethod
    def _predict_proba_safe(model: Pipeline, X: pd.DataFrame) -> np.ndarray:
        model_obj = model.named_steps["model"]

        if hasattr(model_obj, "predict_proba"):
            proba = model.predict_proba(X)

            if proba.ndim == 2 and proba.shape[1] == 2:
                return proba[:, 1]

            if proba.ndim == 2 and proba.shape[1] == 1:
                if hasattr(model_obj, "classes_") and len(model_obj.classes_) == 1:
                    only_class = model_obj.classes_[0]
                    if only_class == 1:
                        return np.ones(len(X), dtype=float)
                    return np.zeros(len(X), dtype=float)
                return proba[:, 0]

        pred = model.predict(X)
        return np.asarray(pred, dtype=float)

    @staticmethod
    def _safe_roc_auc(y_true: pd.Series, y_prob: np.ndarray) -> float | None:
        if pd.Series(y_true).nunique() < 2:
            return None
        return float(roc_auc_score(y_true, y_prob))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    dataset_path = os.getenv(
        "TRAINING_DATASET_PATH",
        "./data/aircraft_maintenance_intelligence_dataset.xlsx",
    )
    sheet_name_env = os.getenv("TRAINING_SHEET_NAME", "0")
    sheet_name: str | int = int(sheet_name_env) if sheet_name_env.isdigit() else sheet_name_env
    failure_horizon = int(os.getenv("FAILURE_HORIZON", "20"))
    model_dir = os.getenv("MODEL_DIR", "./models")

    trainer = PredictiveMaintenanceTrainer(
        excel_path=dataset_path,
        sheet_name=sheet_name,
        failure_horizon=failure_horizon,
        model_dir=model_dir,
    )
    trainer.load_dataset()
    trainer.prepare_training_data()
    bundle = trainer.train_and_save()

    print(json.dumps(asdict(bundle), indent=2))