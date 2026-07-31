"""
Production inference module for predictive maintenance.

Improved version:
1. Keeps inference features aligned with training.
2. Tolerates missing engineered features by creating NaN columns.
3. Applies consistency reconciliation between failure risk and RUL.
4. Produces a more humanly coherent health score.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import joblib
import numpy as np
import pandas as pd


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

INTERACTION_FEATURES = [
    "EGT_to_FuelFlow",
    "OilPressure_to_RPM",
    "Vibration_x_RPM",
    "BrakeTemp_to_LandingSpeed",
    "Aircraft_Age_In_Cycles",
]


@dataclass
class MaintenancePrediction:
    aircraft_id: str
    flight_cycle: int
    failure_probability_next_n_flights: float
    predicted_failure_label: int
    predicted_rul_raw: float
    predicted_rul: float
    recorded_rul_from_dataset: float | None
    rul_difference: float | None
    prediction_consistency_warning: bool
    engine_health_score: float
    risk_band: str
    top_feature_snapshot: dict[str, Any] = field(default_factory=dict)
    model_metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "aircraft_id": self.aircraft_id,
            "flight_cycle": self.flight_cycle,
            "failure_probability_next_n_flights": self.failure_probability_next_n_flights,
            "predicted_failure_label": self.predicted_failure_label,
            "predicted_rul_raw": self.predicted_rul_raw,
            "predicted_rul": self.predicted_rul,
            "recorded_rul_from_dataset": self.recorded_rul_from_dataset,
            "rul_difference": self.rul_difference,
            "prediction_consistency_warning": self.prediction_consistency_warning,
            "engine_health_score": self.engine_health_score,
            "risk_band": self.risk_band,
            "top_feature_snapshot": self.top_feature_snapshot,
            "model_metadata": self.model_metadata,
        }


class PredictiveMaintenanceModel:
    def __init__(self, model_dir: str | Path) -> None:
        self.model_dir = Path(model_dir)
        self.classification_model: Any | None = None
        self.regression_model: Any | None = None
        self.metadata: dict[str, Any] | None = None
        self.metrics: dict[str, Any] | None = None

    def load_artifacts(self) -> None:
        classifier_path = self.model_dir / "predictive_classifier.joblib"
        regressor_path = self.model_dir / "predictive_regressor.joblib"
        metadata_path = self.model_dir / "predictive_metadata.json"
        metrics_path = self.model_dir / "predictive_metrics.json"

        if not classifier_path.exists():
            raise FileNotFoundError(f"Classifier artifact not found: {classifier_path}")
        if not regressor_path.exists():
            raise FileNotFoundError(f"Regressor artifact not found: {regressor_path}")
        if not metadata_path.exists():
            raise FileNotFoundError(f"Metadata artifact not found: {metadata_path}")

        self.classification_model = joblib.load(classifier_path)
        self.regression_model = joblib.load(regressor_path)
        self.metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        self.metrics = json.loads(metrics_path.read_text(encoding="utf-8")) if metrics_path.exists() else {}

        logger.info("Loaded predictive maintenance artifacts from %s", self.model_dir)

    def predict_from_excel(
        self,
        excel_path: str | Path,
        sheet_name: str | int = 0,
        aircraft_id: str | None = None,
    ) -> MaintenancePrediction:
        data = self._load_and_clean_dataset(excel_path=excel_path, sheet_name=sheet_name)
        return self.predict_from_dataframe(data, aircraft_id=aircraft_id)

    def predict_from_dataframe(
        self,
        data: pd.DataFrame,
        aircraft_id: str | None = None,
    ) -> MaintenancePrediction:
        self._require_artifacts()

        cleaned = data.copy()
        engineered = self._prepare_inference_features(cleaned)

        available_aircraft = sorted(engineered["Aircraft_ID"].astype(str).unique().tolist())
        if not available_aircraft:
            raise ValueError("No aircraft data found for predictive inference.")

        if aircraft_id:
            selected_aircraft = str(aircraft_id)
        else:
            latest_global_row = engineered.sort_values(["Flight_Cycle"]).iloc[-1]
            selected_aircraft = str(latest_global_row["Aircraft_ID"])

        aircraft_history = engineered[
            engineered["Aircraft_ID"].astype(str) == selected_aircraft
        ].copy()

        if aircraft_history.empty:
            raise ValueError(f"No records found for aircraft: {selected_aircraft}")

        latest = aircraft_history.sort_values("Flight_Cycle").iloc[-1].copy()
        feature_columns = list(self.metadata["feature_columns"])

        for col in feature_columns:
            if col not in engineered.columns:
                engineered[col] = np.nan

        for col in feature_columns:
            if col not in latest.index:
                latest[col] = np.nan

        X_latest = pd.DataFrame([latest[feature_columns]])

        raw_failure_probability = float(
            self._predict_proba_safe(self.classification_model, X_latest)[0]
        )
        raw_failure_probability = float(np.clip(raw_failure_probability, 0.0, 1.0))

        raw_predicted_rul = float(self.regression_model.predict(X_latest)[0])
        raw_predicted_rul = max(0.0, raw_predicted_rul)

        recorded_rul: float | None = None
        if "Remaining_Useful_Life" in latest.index and pd.notna(latest["Remaining_Useful_Life"]):
            recorded_rul = round(float(latest["Remaining_Useful_Life"]), 2)

        reconciled_probability, reconciled_rul, consistency_warning = self._reconcile_predictions(
            failure_probability=raw_failure_probability,
            predicted_rul=raw_predicted_rul,
            recorded_rul=recorded_rul,
        )

        risk_band = self._risk_band(reconciled_probability)
        predicted_label = int(reconciled_probability >= self.metadata.get("classifier_threshold", 0.5))

        rul_difference: float | None = None
        if recorded_rul is not None:
            rul_difference = round(reconciled_rul - recorded_rul, 2)

        engine_health_score = self._compute_health_score(
            failure_probability=reconciled_probability,
            predicted_rul=reconciled_rul,
            recorded_rul=recorded_rul,
        )

        return MaintenancePrediction(
            aircraft_id=selected_aircraft,
            flight_cycle=int(latest["Flight_Cycle"]),
            failure_probability_next_n_flights=round(reconciled_probability, 4),
            predicted_failure_label=predicted_label,
            predicted_rul_raw=round(raw_predicted_rul, 2),
            predicted_rul=round(reconciled_rul, 2),
            recorded_rul_from_dataset=recorded_rul,
            rul_difference=rul_difference,
            prediction_consistency_warning=consistency_warning,
            engine_health_score=round(engine_health_score, 2),
            risk_band=risk_band,
            top_feature_snapshot=self._build_feature_snapshot(latest),
            model_metadata={
                "failure_horizon": self.metadata.get("failure_horizon"),
                "model_type_classifier": self.metadata.get("model_type_classifier"),
                "model_type_regressor": self.metadata.get("model_type_regressor"),
                "rul_target_source": self.metadata.get("rul_target_source"),
            },
        )

    def get_training_metrics(self) -> dict[str, Any]:
        metrics_path = self.model_dir / "predictive_metrics.json"
        if not metrics_path.exists():
            raise FileNotFoundError(f"Metrics artifact not found: {metrics_path}")
        return json.loads(metrics_path.read_text(encoding="utf-8"))

    def _load_and_clean_dataset(
        self,
        excel_path: str | Path,
        sheet_name: str | int = 0,
    ) -> pd.DataFrame:
        excel_path = Path(excel_path)
        if not excel_path.exists():
            raise FileNotFoundError(f"Dataset not found: {excel_path}")

        data = pd.read_excel(excel_path, sheet_name=sheet_name)
        data = self._clean_columns(data)
        self._validate_required_columns(data)

        data["Aircraft_ID"] = data["Aircraft_ID"].astype(str)
        data["Flight_Cycle"] = pd.to_numeric(data["Flight_Cycle"], errors="coerce")
        data = data.dropna(subset=["Aircraft_ID", "Flight_Cycle"])
        data["Flight_Cycle"] = data["Flight_Cycle"].astype(int)

        for column in RAW_FEATURE_COLUMNS + ["Remaining_Useful_Life"]:
            if column in data.columns:
                data[column] = pd.to_numeric(data[column], errors="coerce")

        return data.sort_values(["Aircraft_ID", "Flight_Cycle"]).reset_index(drop=True)

    def _prepare_inference_features(self, data: pd.DataFrame) -> pd.DataFrame:
        data = data.copy()
        grouped = data.groupby("Aircraft_ID", group_keys=False)

        available_raw_features = [c for c in RAW_FEATURE_COLUMNS if c in data.columns]
        if not available_raw_features:
            raise ValueError("None of the expected raw feature columns were found.")

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

        return data

    def _require_artifacts(self) -> None:
        if self.classification_model is None or self.regression_model is None or self.metadata is None:
            raise ValueError("Model artifacts are not loaded. Call load_artifacts() first.")

    def _reconcile_predictions(
        self,
        failure_probability: float,
        predicted_rul: float,
        recorded_rul: float | None,
    ) -> tuple[float, float, bool]:
        rules = self.metadata.get("consistency_rules", {}) if self.metadata else {}

        critical_p = float(rules.get("critical_probability_threshold", 0.85))
        high_p = float(rules.get("high_probability_threshold", 0.65))
        moderate_p = float(rules.get("moderate_probability_threshold", 0.35))

        critical_max_rul = float(rules.get("critical_max_rul", 15))
        high_max_rul = float(rules.get("high_max_rul", 30))
        moderate_max_rul = float(rules.get("moderate_max_rul", 60))

        reconciled_rul = float(max(0.0, predicted_rul))
        reconciled_probability = float(np.clip(failure_probability, 0.0, 1.0))
        consistency_warning = False

        # If the uploaded dataset already contains current RUL, use it as an anchor.
        if recorded_rul is not None:
            # Blend model prediction with observed RUL for more operationally believable outputs.
            reconciled_rul = 0.6 * reconciled_rul + 0.4 * float(recorded_rul)

        # Force coherence between very high risk and RUL
        if reconciled_probability >= critical_p:
            if reconciled_rul > critical_max_rul:
                consistency_warning = True
                reconciled_rul = critical_max_rul
        elif reconciled_probability >= high_p:
            if reconciled_rul > high_max_rul:
                consistency_warning = True
                reconciled_rul = high_max_rul
        elif reconciled_probability >= moderate_p:
            if reconciled_rul > moderate_max_rul:
                consistency_warning = True
                reconciled_rul = moderate_max_rul

        # Reverse consistency: if RUL is very low, probability should not be too low
        if reconciled_rul <= 10:
            reconciled_probability = max(reconciled_probability, 0.85)
        elif reconciled_rul <= 20:
            reconciled_probability = max(reconciled_probability, 0.65)
        elif reconciled_rul <= 40:
            reconciled_probability = max(reconciled_probability, 0.35)

        reconciled_probability = float(np.clip(reconciled_probability, 0.0, 0.995))
        reconciled_rul = float(max(0.0, reconciled_rul))

        return reconciled_probability, reconciled_rul, consistency_warning

    def _compute_health_score(
        self,
        failure_probability: float,
        predicted_rul: float,
        recorded_rul: float | None,
    ) -> float:
        # Base health from failure probability
        base_health = (1.0 - failure_probability) * 100.0

        # Add RUL-informed moderation so health is not absurdly low when RUL is still moderate.
        rul_reference = recorded_rul if recorded_rul is not None and recorded_rul > 0 else predicted_rul
        rul_reference = max(0.0, float(rul_reference))

        # Convert RUL into a 0-100 support factor
        rul_support = min((rul_reference / 60.0) * 100.0, 100.0)

        # Weighted blend: failure risk dominates, but RUL still matters
        health_score = 0.7 * base_health + 0.3 * rul_support

        return float(np.clip(health_score, 0.0, 100.0))

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
    def _predict_proba_safe(model: Any, X: pd.DataFrame) -> np.ndarray:
        if hasattr(model, "predict_proba"):
            proba = model.predict_proba(X)

            if proba.ndim == 2 and proba.shape[1] == 2:
                return proba[:, 1]

            if proba.ndim == 2 and proba.shape[1] == 1:
                return proba[:, 0]

        pred = model.predict(X)
        return np.asarray(pred, dtype=float)

    @staticmethod
    def _risk_band(probability: float) -> str:
        if probability >= 0.85:
            return "CRITICAL"
        if probability >= 0.65:
            return "HIGH"
        if probability >= 0.35:
            return "MODERATE"
        return "LOW"

    @staticmethod
    def _build_feature_snapshot(latest_row: pd.Series) -> dict[str, Any]:
        keys_of_interest = [
            "Engine_Exhaust_Gas_Temperature",
            "Fuel_Flow",
            "Oil_Pressure",
            "Engine_RPM",
            "Turbine_Vibration",
            "Hydraulic_Pressure",
            "Brake_Temperature",
            "Landing_Speed",
            "Wind_Speed",
            "Altitude",
            "Humidity",
            "Remaining_Useful_Life",
        ]

        snapshot: dict[str, Any] = {}
        for key in keys_of_interest:
            if key in latest_row.index and pd.notna(latest_row[key]):
                value = latest_row[key]
                if isinstance(value, (np.floating, float)):
                    snapshot[key] = round(float(value), 3)
                elif isinstance(value, (np.integer, int)):
                    snapshot[key] = int(value)
                else:
                    snapshot[key] = value
        return snapshot