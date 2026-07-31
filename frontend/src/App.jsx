import { useEffect, useMemo, useState } from 'react';
import { getMaintenanceRecommendation, healthCheck, uploadAnalyticsFile } from './api/client';
import PanelCard from './components/PanelCard';

function App() {
  const [excelFile, setExcelFile] = useState(null);
  const [manualFile, setManualFile] = useState(null);
  const [status, setStatus] = useState('Checking backend connection...');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingPhase, setLoadingPhase] = useState('');
  const [analyticsResult, setAnalyticsResult] = useState(null);
  const [recommendation, setRecommendation] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const pingBackend = async () => {
      try {
        const result = await healthCheck();
        setStatus(`Backend online · ${result.service || 'API ready'}`);
      } catch (err) {
        setStatus('Backend offline. Start FastAPI on port 8000.');
        setError(err.message);
      }
    };

    pingBackend();
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!excelFile) {
      setError('Please upload an Excel file first.');
      return;
    }

    setIsLoading(true);
    setLoadingPhase('analytics');
    setError('');
    setRecommendation(null);

    try {
      const response = await uploadAnalyticsFile(excelFile);
      setAnalyticsResult(response);
      setStatus(`Analytics ready for ${response.aircraft_id || 'selected aircraft'}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
      setLoadingPhase('');
    }
  };

  const handleRecommendation = async () => {
    if (!analyticsResult) {
      setError('Generate analytics first.');
      return;
    }

    setIsLoading(true);
    setLoadingPhase('ai');
    setError('');

    try {
      const response = await getMaintenanceRecommendation(analyticsResult);
      setRecommendation(response);
      setStatus('AI maintenance recommendation generated');
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
      setLoadingPhase('');
    }
  };

  const currentRecord = analyticsResult?.summary?.current_record;
  const historicalAnalysis = analyticsResult?.summary?.historical_analysis || [];

  const predictiveBlock = analyticsResult?.predictive_maintenance || null;
  const predictivePrediction = predictiveBlock?.prediction || null;
  const predictiveEvaluation = predictiveBlock?.model_evaluation || null;
  const predictiveClassificationMetrics = predictiveEvaluation?.classification_metrics || null;
  const predictiveRegressionMetrics = predictiveEvaluation?.regression_metrics || null;

  const metrics = useMemo(() => {
    if (!analyticsResult?.summary) return [];

    const summary = analyticsResult.summary;
    const analysis = summary.historical_analysis || [];
    const riskSignal = analysis.find((item) => item.column === 'Risk_Score');
    const vibrationSignal = analysis.find((item) => item.column === 'Engine_Vibration');
    const rulSignal = analysis.find((item) => item.column === 'Remaining_Useful_Life');
    const record = summary.current_record || {};

    return [
      {
        icon: '✈',
        label: 'Aircraft',
        value: analyticsResult.aircraft_id || 'N/A',
        sub: record.Aircraft_Model || 'Unknown model',
        accent: 'indigo',
      },
      {
        icon: '⚙',
        label: 'Engine',
        value: record.Engine_Model || 'N/A',
        sub: `Airport: ${record.Airport_Code || 'N/A'}`,
        accent: 'cyan',
      },
      {
        icon: '🔄',
        label: 'Flight Cycle',
        value: summary.latest_flight_cycle || 'N/A',
        sub: `${record.Flight_Hours || 0} flight hours logged`,
        accent: 'violet',
      },
      {
        icon: '🔧',
        label: 'Since Overhaul',
        value: record.Cycles_Since_Overhaul || 'N/A',
        sub: `Last maintenance: ${record.Last_Maintenance_Date || 'N/A'}`,
        accent: 'blue',
      },
      {
        icon: '⚠',
        label: 'Risk Score',
        value: riskSignal ? riskSignal.latest_value : 'N/A',
        sub: riskSignal
          ? `${riskSignal.change_percent > 0 ? '+' : ''}${riskSignal.change_percent.toFixed(1)}% vs history`
          : '',
        accent:
          riskSignal && riskSignal.latest_value > 70
            ? 'red'
            : riskSignal && riskSignal.latest_value > 50
            ? 'amber'
            : 'emerald',
      },
      {
        icon: '🛡',
        label: 'Remaining Life',
        value: rulSignal ? `${rulSignal.latest_value} cycles` : 'N/A',
        sub: rulSignal
          ? `${rulSignal.change_percent > 0 ? '+' : ''}${rulSignal.change_percent.toFixed(1)}% vs avg`
          : '',
        accent:
          rulSignal && rulSignal.latest_value < 30
            ? 'red'
            : rulSignal && rulSignal.latest_value < 50
            ? 'amber'
            : 'emerald',
      },
      {
        icon: '📳',
        label: 'Vibration',
        value: vibrationSignal ? `${vibrationSignal.latest_value} mm/s` : 'N/A',
        sub: vibrationSignal ? vibrationSignal.trend_direction : '',
        accent:
          vibrationSignal && vibrationSignal.trend_direction === 'INCREASING'
            ? 'orange'
            : 'teal',
      },
      {
        icon: '📊',
        label: 'Signals',
        value: historicalAnalysis.length,
        sub: `Window: ${analyticsResult.summary.historical_window_size || 10} cycles`,
        accent: 'pink',
      },
      {
        icon: '🌡',
        label: 'Ambient',
        value: `${currentRecord?.Ambient_Temperature?.toFixed(1) || 'N/A'}°C`,
        sub: `Humidity: ${currentRecord?.Humidity || 'N/A'}%`,
        accent: 'cyan',
      },
    ];
  }, [analyticsResult, currentRecord, historicalAnalysis.length]);

  const predictiveMetrics = useMemo(() => {
    if (!predictivePrediction) return [];

    return [
      {
        icon: '🧠',
        label: 'Health Score',
        value:
          predictivePrediction.engine_health_score != null
            ? `${predictivePrediction.engine_health_score}%`
            : 'N/A',
        sub: 'Derived from predictive failure risk',
        accent:
          predictivePrediction.engine_health_score >= 85
            ? 'emerald'
            : predictivePrediction.engine_health_score >= 65
            ? 'amber'
            : 'red',
      },
      {
        icon: '⚠',
        label: 'Failure Probability',
        value:
          predictivePrediction.failure_probability_next_n_flights != null
            ? `${(predictivePrediction.failure_probability_next_n_flights * 100).toFixed(1)}%`
            : 'N/A',
        sub: 'Predicted within next 20 flights',
        accent:
          predictivePrediction.failure_probability_next_n_flights >= 0.4
            ? 'red'
            : predictivePrediction.failure_probability_next_n_flights >= 0.2
            ? 'amber'
            : 'emerald',
      },
      {
        icon: '⏳',
        label: 'Predicted RUL',
        value:
          predictivePrediction.predicted_rul != null
            ? `${predictivePrediction.predicted_rul} cycles`
            : 'N/A',
        sub: 'Estimated remaining useful life',
        accent:
          predictivePrediction.predicted_rul <= 20
            ? 'red'
            : predictivePrediction.predicted_rul <= 50
            ? 'amber'
            : 'emerald',
      },
      {
        icon: '🛬',
        label: 'Risk Band',
        value: predictivePrediction.risk_band || 'N/A',
        sub: predictivePrediction.predicted_failure_label
          ? 'Maintenance attention advised'
          : 'No immediate predicted failure',
        accent:
          predictivePrediction.risk_band === 'CRITICAL'
            ? 'red'
            : predictivePrediction.risk_band === 'HIGH'
            ? 'orange'
            : predictivePrediction.risk_band === 'MODERATE'
            ? 'amber'
            : 'teal',
      },
    ];
  }, [predictivePrediction]);

  const engineGauges = useMemo(() => {
    if (!currentRecord) return [];
    return [
      { label: 'Engine Temp', value: currentRecord.Engine_Temperature, unit: '°C', max: 900, warn: 750 },
      { label: 'EGT', value: currentRecord.Exhaust_Gas_Temperature, unit: '°C', max: 850, warn: 700 },
      { label: 'Oil Temp', value: currentRecord.Oil_Temperature, unit: '°C', max: 150, warn: 110 },
      { label: 'Oil Pressure', value: currentRecord.Oil_Pressure, unit: 'psi', max: 65, warn: 45 },
      { label: 'Engine RPM', value: currentRecord.Engine_RPM, unit: 'RPM', max: 12000, warn: 10500 },
      { label: 'Fuel Flow', value: currentRecord.Fuel_Flow, unit: 'kg/h', max: 3200, warn: 2800 },
      { label: 'Compressor', value: currentRecord.Compressor_Pressure, unit: 'psi', max: 55, warn: 48 },
      { label: 'Hydraulic', value: currentRecord.Hydraulic_Pressure, unit: 'psi', max: 3500, warn: 3200 },
    ];
  }, [currentRecord]);

  const recommendationSummary = recommendation?.report || null;

  const workflowSteps = [
    {
      number: '01',
      title: 'Telemetry Intake',
      description: 'Upload landed-flight engineering data for post-flight diagnosis.',
    },
    {
      number: '02',
      title: 'Condition Mapping',
      description: 'Benchmark the newest engine signals against recent operational patterns.',
    },
    {
      number: '03',
      title: 'Predictive Scoring',
      description: 'Forecast failure probability, health score, and remaining useful life.',
    },
    {
      number: '04',
      title: 'Action Decision',
      description: 'Generate maintenance actionables aligned with analytics and manual context.',
    },
  ];

  const quickStats = useMemo(() => {
    return [
      {
        label: 'Telemetry',
        value: analyticsResult ? 'Ready' : 'Pending',
      },
      {
        label: 'Manual',
        value: manualFile ? 'Loaded' : 'Optional',
      },
      {
        label: 'AI Board',
        value: recommendationSummary ? 'Generated' : 'Idle',
      },
      {
        label: 'Prediction',
        value: predictivePrediction ? 'Active' : 'Waiting',
      },
    ];
  }, [analyticsResult, manualFile, recommendationSummary, predictivePrediction]);

  const getGaugeLevel = (value, warn, max) => {
    const pct = (value / max) * 100;
    if (value >= warn) return 'level-warn';
    if (pct > 85) return 'level-danger';
    return 'level-ok';
  };

  const getTrendArrow = (direction) => {
    switch (direction) {
      case 'INCREASING':
        return '↑';
      case 'DECREASING':
        return '↓';
      case 'STABLE':
        return '→';
      default:
        return '·';
    }
  };

  const getHealthBadgeClass = (statusValue) => {
    switch (statusValue?.toUpperCase()) {
      case 'MONITOR':
        return 'monitor';
      case 'OK':
      case 'NORMAL':
        return 'ok';
      case 'CRITICAL':
      case 'ALERT':
        return 'critical';
      default:
        return 'monitor';
    }
  };

  const getRiskBadgeClass = (level) => {
    switch (level?.toUpperCase()) {
      case 'LOW':
        return 'risk-low';
      case 'MEDIUM':
      case 'MODERATE':
        return 'risk-medium';
      case 'HIGH':
      case 'CRITICAL':
        return 'risk-high';
      default:
        return 'risk-medium';
    }
  };

  return (
    <div className="app-shell">
      <div className="aurora aurora-1" aria-hidden="true" />
      <div className="aurora aurora-2" aria-hidden="true" />
      <div className="aurora aurora-3" aria-hidden="true" />
      <div className="grid-glow" aria-hidden="true" />
      <div className="scanline" aria-hidden="true" />

      <header className="hero-panel">
        <div className="hero-panel__content">
          <div className="hero-topline">
            <span className="hero-topline__dot" />
            Aviation intelligence platform
          </div>

          <div className="hero-title-wrap">
            <div className="hero-logo" aria-hidden="true">
              <svg viewBox="0 0 64 64" width="64" height="64">
                <defs>
                  <linearGradient id="heroLogoGradient" x1="0" y1="0" x2="64" y2="64">
                    <stop offset="0%" stopColor="#5eead4" />
                    <stop offset="45%" stopColor="#60a5fa" />
                    <stop offset="100%" stopColor="#c084fc" />
                  </linearGradient>
                </defs>
                <circle cx="32" cy="32" r="29" fill="none" stroke="url(#heroLogoGradient)" strokeWidth="2.2" opacity="0.55" />
                <circle cx="32" cy="32" r="20" fill="none" stroke="url(#heroLogoGradient)" strokeWidth="1.1" opacity="0.26" />
                <path
                  d="M16 37 L28 33 L44 18 L47 21 L34 37 L38 49 L34 51 L28 40 L20 43 Z"
                  fill="url(#heroLogoGradient)"
                  opacity="0.95"
                />
              </svg>
            </div>

            <div className="hero-heading-block">
              <h1 className="hero-title">
                <span className="hero-title-air">Airace</span>
                <span className="hero-title-separator" />
                <span className="hero-title-maint">Maintenance Command</span>
              </h1>
              <p className="hero-subtitle">
                A redesigned mission-control experience for aircraft post-landing analytics,
                predictive maintenance intelligence, and AI-guided engineering decisions.
              </p>
            </div>
          </div>

          <div className="hero-tags">
            <span className="hero-tag">Mission Control UI</span>
            <span className="hero-tag">Predictive Analytics</span>
            <span className="hero-tag">AI Recommendation Engine</span>
            <span className="hero-tag">Operational Readiness</span>
          </div>
        </div>

        <div className="hero-panel__status">
          <div className="status-card">
            <div className="status-card__label">System status</div>
            <div className="status-card__value">
              <span className="status-pulse" />
              {status}
            </div>
          </div>

          <div className="hero-radar" aria-hidden="true">
            <div className="hero-radar__ring hero-radar__ring--1" />
            <div className="hero-radar__ring hero-radar__ring--2" />
            <div className="hero-radar__ring hero-radar__ring--3" />
            <div className="hero-radar__sweep" />
            <div className="hero-radar__blip hero-radar__blip--a" />
            <div className="hero-radar__blip hero-radar__blip--b" />
            <div className="hero-radar__blip hero-radar__blip--c" />
            <div className="hero-radar__center" />
          </div>
        </div>
      </header>

      <section className="quick-strip" aria-label="Quick session overview">
        {quickStats.map((item) => (
          <div className="quick-strip__card" key={item.label}>
            <span className="quick-strip__label">{item.label}</span>
            <strong className="quick-strip__value">{item.value}</strong>
          </div>
        ))}
      </section>

      <section className="timeline-panel" aria-label="Workflow timeline">
        <div className="section-head">
          <div>
            <span className="section-kicker">Workflow</span>
            <h2 className="section-title">From landing data to maintenance action</h2>
          </div>
        </div>

        <div className="timeline-grid">
          {workflowSteps.map((step) => (
            <div key={step.title} className="timeline-step">
              <div className="timeline-step__number">{step.number}</div>
              <div className="timeline-step__body">
                <h4>{step.title}</h4>
                <p>{step.description}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="runway-hero">
        <div className="runway-hero__copy">
          <span className="section-kicker">Flight transition</span>
          <h3>
            {analyticsResult
              ? `Aircraft ${analyticsResult.aircraft_id} is now in the post-landing assessment lane.`
              : 'A landed aircraft is ready to enter the assessment lane.'}
          </h3>
          <p>
            The new interface shifts from a basic dashboard to a command-center layout, emphasizing
            readiness, signal movement, maintenance risk, and decision visibility.
          </p>
        </div>

        <div className="runway-hero__visual" aria-hidden="true">
          <div className="runway-sky">
            <div className="runway-stars" />
            <div className="runway-path">
              <div className="runway-path__line" />
              <div className="runway-path__dot runway-path__dot--1" />
              <div className="runway-path__dot runway-path__dot--2" />
              <div className="runway-path__dot runway-path__dot--3" />
              <div className="runway-plane">✈</div>
            </div>
          </div>
          <div className="runway-labels">
            <span>Touchdown</span>
            <span>Signal Review</span>
            <span>Maintenance Board</span>
          </div>
        </div>
      </section>

      <div className="command-layout">
        <aside className="command-sidebar">
          <PanelCard
            title="Flight Data Intake"
            subtitle="Load the engineering telemetry export and begin the post-flight analysis cycle."
            accent="intake"
            icon="📥"
          >
            <form onSubmit={handleSubmit} className="upload-form">
              <label className="file-field">
                <span>Engineering Excel (.xlsx)</span>
                <input
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={(event) => setExcelFile(event.target.files?.[0] || null)}
                />
              </label>

              <div className="asset-pill">
                <span className="asset-pill__label">Loaded file</span>
                <span className="asset-pill__value">{excelFile ? excelFile.name : 'No file selected'}</span>
              </div>

              <p className="helper-text compact">
                Compare the latest landed-flight telemetry against the historical baseline to reveal
                operational condition and anomalies.
              </p>

              <button type="submit" className="primary-btn primary-btn--intake" disabled={isLoading}>
                {isLoading && loadingPhase === 'analytics'
                  ? 'Analyzing telemetry...'
                  : 'Generate Engineering Analytics'}
              </button>
            </form>
          </PanelCard>

          <PanelCard
            title="AI Guidance Console"
            subtitle="Use the analytics output with the maintenance manual for AI-backed guidance."
            accent="ai"
            icon="🧠"
          >
            <label className="file-field">
              <span>Maintenance PDF (.pdf)</span>
              <input
                type="file"
                accept=".pdf"
                onChange={(event) => setManualFile(event.target.files?.[0] || null)}
              />
            </label>

            <div className="asset-pill">
              <span className="asset-pill__label">Manual status</span>
              <span className="asset-pill__value">{manualFile ? manualFile.name : 'No PDF selected'}</span>
            </div>

            <p className="helper-text compact">
              The manual enriches the recommendation with maintenance-threshold references,
              procedural context, and grounded actions.
            </p>

            <button
              className="primary-btn primary-btn--ai wide"
              onClick={handleRecommendation}
              disabled={isLoading || !analyticsResult}
            >
              {isLoading && loadingPhase === 'ai'
                ? 'AI is building the recommendation...'
                : 'Generate AI Recommendation'}
            </button>
          </PanelCard>

          <PanelCard
            title="Session Control"
            subtitle="Live status of your current engineering review pipeline."
            accent="control"
            icon="🛰"
          >
            <div className="control-stack">
              {quickStats.map((item) => (
                <div className="control-item" key={`control-${item.label}`}>
                  <span className="control-item__label">{item.label}</span>
                  <strong className="control-item__value">{item.value}</strong>
                </div>
              ))}
            </div>
          </PanelCard>
        </aside>

        <main className="command-main">
          {error ? <div className="error-box">⚠ {error}</div> : null}

          <section className="main-cluster">
            <div className="section-head">
              <div>
                <span className="section-kicker">Aircraft profile</span>
                <h2 className="section-title">Operational snapshot</h2>
              </div>
            </div>

            <div className="metrics-mosaic">
              {metrics.map((metric) => (
                <div className={`metric-tile ${metric.accent}`} key={metric.label}>
                  <div className="metric-tile__icon">{metric.icon}</div>
                  <div className="metric-tile__content">
                    <span className="metric-tile__label">{metric.label}</span>
                    <strong className="metric-tile__value">{metric.value}</strong>
                    <small className="metric-tile__sub">{metric.sub}</small>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {predictivePrediction ? (
            <section className="main-cluster">
              <div className="section-head">
                <div>
                  <span className="section-kicker">Predictive layer</span>
                  <h2 className="section-title">Machine learning forecast</h2>
                </div>
              </div>

              <div className="predictive-highlight-grid">
                {predictiveMetrics.map((metric) => (
                  <div className={`predictive-spotlight ${metric.accent}`} key={`predictive-${metric.label}`}>
                    <span className="predictive-spotlight__icon">{metric.icon}</span>
                    <span className="predictive-spotlight__label">{metric.label}</span>
                    <strong className="predictive-spotlight__value">{metric.value}</strong>
                    <small className="predictive-spotlight__sub">{metric.sub}</small>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="dual-stage">
            <PanelCard
              title="Engineering Analytics Board"
              subtitle="Sensor conditions, gauges, and historical trend movement from uploaded aircraft telemetry."
              accent="analytics"
              icon="📊"
            >
              {isLoading && loadingPhase === 'analytics' ? (
                <div className="loading-overlay loading-overlay--panel">
                  <div className="loading-rings">
                    <span />
                    <span />
                    <span />
                  </div>
                  <span className="loading-text">Processing telemetry data...</span>
                </div>
              ) : analyticsResult ? (
                <div className="analytics-panel">
                  <div className="aircraft-hero-card">
                    <div className="aircraft-hero-card__badge">Active Aircraft</div>
                    <div className="aircraft-hero-card__main">
                      <div className="aircraft-hero-card__icon">✈</div>
                      <div>
                        <h4>
                          {analyticsResult.aircraft_id} — {currentRecord?.Aircraft_Model || 'Unknown'}
                        </h4>
                        <div className="aircraft-meta">
                          <span>🔧 {currentRecord?.Engine_Model || 'N/A'}</span>
                          <span>📍 {currentRecord?.Airport_Code || 'N/A'}</span>
                          <span>🔄 Cycle {analyticsResult.summary.latest_flight_cycle}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {predictivePrediction ? (
                    <div className="prediction-banner">
                      <div className="prediction-banner__head">
                        <h4>Predictive Intelligence Layer</h4>
                        <div className="status-banner">
                          <span className={`status-badge ${getRiskBadgeClass(predictivePrediction.risk_band)}`}>
                            <span className="badge-dot" />
                            {predictivePrediction.risk_band} RISK
                          </span>
                          <span className={`status-badge ${predictivePrediction.predicted_failure_label ? 'critical' : 'ok'}`}>
                            <span className="badge-dot" />
                            {predictivePrediction.predicted_failure_label
                              ? 'FAILURE LIKELY WITHIN HORIZON'
                              : 'NO FAILURE PREDICTED'}
                          </span>
                        </div>
                      </div>

                      <div className="info-row">
                        <div className="info-card">
                          <span className="info-label">Health Score</span>
                          <span className="info-value">
                            {predictivePrediction.engine_health_score != null
                              ? `${predictivePrediction.engine_health_score}%`
                              : 'N/A'}
                          </span>
                          <span className="info-sub">ML-derived aircraft health estimate</span>
                        </div>

                        <div className="info-card">
                          <span className="info-label">Failure Probability</span>
                          <span className="info-value">
                            {predictivePrediction.failure_probability_next_n_flights != null
                              ? `${(predictivePrediction.failure_probability_next_n_flights * 100).toFixed(1)}%`
                              : 'N/A'}
                          </span>
                          <span className="info-sub">Predicted within next 20 flights</span>
                        </div>

                        <div className="info-card">
                          <span className="info-label">Predicted RUL</span>
                          <span className="info-value">
                            {predictivePrediction.predicted_rul != null
                              ? `${predictivePrediction.predicted_rul} cycles`
                              : 'N/A'}
                          </span>
                          <span className="info-sub">Estimated remaining useful life</span>
                        </div>

                        <div className="info-card">
                          <span className="info-label">Model Accuracy</span>
                          <span className="info-value">
                            {predictiveClassificationMetrics?.accuracy != null
                              ? `${(predictiveClassificationMetrics.accuracy * 100).toFixed(1)}%`
                              : 'N/A'}
                          </span>
                          <span className="info-sub">
                            ROC-AUC:{' '}
                            {predictiveClassificationMetrics?.roc_auc != null
                              ? predictiveClassificationMetrics.roc_auc.toFixed(3)
                              : 'N/A'}
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  <div className="gauge-wall">
                    {engineGauges.map((gauge) => {
                      const pct = Math.min(((gauge.value || 0) / gauge.max) * 100, 100);
                      const level = getGaugeLevel(gauge.value || 0, gauge.warn, gauge.max);

                      return (
                        <div className="gauge-card gauge-card--orbital" key={gauge.label}>
                          <div className="gauge-card__head">
                            <span className="gauge-label">{gauge.label}</span>
                            <span className={`gauge-state ${level}`}>{level.replace('level-', '').toUpperCase()}</span>
                          </div>

                          <div className="gauge-value-row">
                            <span className="gauge-value">{gauge.value?.toLocaleString() || 'N/A'}</span>
                            <span className="gauge-unit">{gauge.unit}</span>
                          </div>

                          <div className="gauge-bar-track">
                            <div className={`gauge-bar-fill ${level}`} style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="signal-list signal-list--board">
                    <h4>
                      Signal Trends
                      <span className="signal-count">{historicalAnalysis.length} parameters</span>
                    </h4>

                    <div className="signal-row signal-row-head">
                      <span>Parameter</span>
                      <span style={{ textAlign: 'right' }}>Current</span>
                      <span style={{ textAlign: 'right' }}>Change</span>
                      <span>Trend</span>
                    </div>

                    {historicalAnalysis.map((item) => (
                      <div key={item.column} className="signal-row">
                        <span className="signal-name">{item.column.replace(/_/g, ' ')}</span>
                        <span className="signal-value">{item.latest_value.toLocaleString()}</span>
                        <span className={`signal-change ${item.change_percent >= 0 ? 'positive' : 'negative'}`}>
                          {item.change_percent > 0 ? '+' : ''}
                          {item.change_percent.toFixed(1)}%
                        </span>
                        <span className={`trend-badge ${item.trend_direction.toLowerCase()}`}>
                          <span className="trend-arrow">{getTrendArrow(item.trend_direction)}</span>
                          {item.trend_direction}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="empty-state empty-state--large">
                  <span className="empty-state-icon">📊</span>
                  Upload the Excel file and generate engineering analytics to populate the operational board.
                </p>
              )}
            </PanelCard>

            <PanelCard
              title="AI Maintenance Decision Board"
              subtitle="Maintenance guidance generated from analytics context and aviation-manual grounding."
              accent="ai"
              icon="✨"
              badge={
                <span className="panel-badge ai-badge">
                  <span className="ai-sparkle">AI</span>
                  Decision Engine
                </span>
              }
            >
              {isLoading && loadingPhase === 'ai' ? (
                <div className="loading-overlay loading-overlay--panel">
                  <div className="loading-rings">
                    <span />
                    <span />
                    <span />
                  </div>
                  <span className="loading-text">AI is analyzing aircraft health...</span>
                </div>
              ) : recommendationSummary ? (
                <div className="recommendation-panel">
                  <div className="ai-command-card">
                    <div className="ai-command-card__icon">🧠</div>
                    <div>
                      <span className="ai-label">AI Analysis</span>
                      <div className="ai-meta-line">
                        {recommendationSummary.aircraft} · {recommendationSummary.aircraft_model}
                      </div>
                    </div>
                  </div>

                  <div className="status-banner">
                    <span className={`status-badge ${getHealthBadgeClass(recommendationSummary.health_status)}`}>
                      <span className="badge-dot" />
                      {recommendationSummary.health_status}
                    </span>
                    <span className={`status-badge ${getRiskBadgeClass(recommendationSummary.risk_level)}`}>
                      <span className="badge-dot" />
                      {recommendationSummary.risk_level} RISK
                    </span>
                    <span className={`status-badge ${recommendationSummary.safe_for_next_flight ? 'ok' : 'critical'}`}>
                      <span className="badge-dot" />
                      {recommendationSummary.safe_for_next_flight ? 'SAFE FOR FLIGHT' : 'GROUND AIRCRAFT'}
                    </span>
                  </div>

                  {recommendationSummary.overall_summary && (
                    <div className="overall-summary">
                      <p>{recommendationSummary.overall_summary}</p>
                    </div>
                  )}

                  {recommendationSummary.final_flight_decision && (
                    <div className="flight-decision">
                      <div className="decision-header">
                        <div
                          className={`decision-icon ${
                            recommendationSummary.final_flight_decision.can_fly_now ? 'fly' : 'ground'
                          }`}
                        >
                          {recommendationSummary.final_flight_decision.can_fly_now ? '✅' : '🚫'}
                        </div>
                        <div>
                          <div className="decision-title">
                            {recommendationSummary.final_flight_decision.decision?.replace(/_/g, ' ')}
                          </div>
                          <div className="decision-subtitle">
                            {recommendationSummary.final_flight_decision.required_before_next_flight}
                          </div>
                        </div>
                      </div>

                      <div className="decision-statement">
                        {recommendationSummary.final_flight_decision.ui_statement}
                      </div>

                      {recommendationSummary.final_flight_decision.decision_rationale && (
                        <div className="decision-rationale">
                          💡 {recommendationSummary.final_flight_decision.decision_rationale}
                        </div>
                      )}
                    </div>
                  )}

                  {recommendationSummary.threshold_violations?.length > 0 && (
                    <div className="violations-section">
                      <h4>Threshold Violations</h4>
                      {recommendationSummary.threshold_violations.map((v, i) => (
                        <div className="violation-card" key={i}>
                          <div className="violation-header">
                            <span className="violation-param">{v.parameter?.replace(/_/g, ' ')}</span>
                            <span className="violation-severity">{v.severity}</span>
                          </div>

                          <div className="violation-values">
                            <div className="violation-val">
                              <label>Observed</label>
                              <span>{v.observed_value}</span>
                            </div>
                            <div className="violation-val">
                              <label>Threshold</label>
                              <span>{v.manual_threshold}</span>
                            </div>
                          </div>

                          {v.explanation && <div className="violation-explanation">{v.explanation}</div>}
                          {v.manual_reference && <span className="manual-ref">📖 {v.manual_reference}</span>}
                        </div>
                      ))}
                    </div>
                  )}

                  {recommendationSummary.root_cause && (
                    <div className="root-cause-card">
                      <h4>Root Cause Analysis</h4>
                      <div className="cause-title">{recommendationSummary.root_cause.most_likely_cause}</div>
                      <ul className="evidence-list">
                        {(recommendationSummary.root_cause.supporting_evidence || []).map((e, i) => (
                          <li key={i}>{e}</li>
                        ))}
                      </ul>
                      {recommendationSummary.root_cause.manual_reference && (
                        <span className="manual-ref">📖 {recommendationSummary.root_cause.manual_reference}</span>
                      )}
                    </div>
                  )}

                  {recommendationSummary.maintenance_actions?.length > 0 && (
                    <div className="actions-list">
                      <h4>Maintenance Actions</h4>
                      {recommendationSummary.maintenance_actions.map((action, i) => (
                        <div className="action-item" key={i}>
                          <div className="action-priority">P{action.priority}</div>
                          <div className="action-content">
                            <div className="action-text">{action.action}</div>
                            <div className="action-reason">{action.reason}</div>
                            {action.manual_reference && <span className="manual-ref">📖 {action.manual_reference}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {recommendationSummary.inspection_checklist?.length > 0 && (
                    <div className="checklist-section">
                      <h4>Inspection Checklist</h4>
                      {recommendationSummary.inspection_checklist.map((item, i) => (
                        <div className="checklist-item" key={i}>
                          <div className="checklist-step">{item.step}</div>
                          <div className="checklist-content">
                            <div className="check-title">{item.inspection_item}</div>
                            <div className="check-criteria">✓ {item.acceptance_criteria}</div>
                            {item.manual_reference && <span className="manual-ref">📖 {item.manual_reference}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="info-row">
                    <div className="info-card">
                      <span className="info-label">AI Confidence</span>
                      <span className="info-value">
                        {recommendationSummary.confidence?.score
                          ? `${(recommendationSummary.confidence.score * 100).toFixed(0)}%`
                          : 'N/A'}
                      </span>
                      <div className="confidence-bar-track">
                        <div
                          className="confidence-bar-fill"
                          style={{ width: `${(recommendationSummary.confidence?.score || 0) * 100}%` }}
                        />
                      </div>
                      {recommendationSummary.confidence?.rationale && (
                        <span className="info-sub">{recommendationSummary.confidence.rationale}</span>
                      )}
                    </div>

                    <div className="info-card">
                      <span className="info-label">Work Order Type</span>
                      <span className="info-value">
                        {recommendationSummary.work_order?.work_order_type || 'N/A'}
                      </span>
                      <span className="info-sub">
                        Priority: {recommendationSummary.work_order?.priority || 'N/A'}
                      </span>
                      <span className="info-sub">
                        {recommendationSummary.work_order?.estimated_maintenance_category || ''}
                      </span>
                    </div>
                  </div>

                  {recommendationSummary.work_order && (
                    <div className="work-order-card">
                      <h4>Work Order — {recommendationSummary.work_order.title}</h4>

                      <div className="wo-meta">
                        <div className="wo-meta-item">
                          <label>Aircraft</label>
                          <span>{recommendationSummary.work_order.aircraft_id}</span>
                        </div>
                        <div className="wo-meta-item">
                          <label>Category</label>
                          <span>{recommendationSummary.work_order.estimated_maintenance_category}</span>
                        </div>
                      </div>

                      {recommendationSummary.work_order.tasks?.length > 0 && (
                        <ul className="wo-tasks">
                          {recommendationSummary.work_order.tasks.map((task, i) => (
                            <li key={i}>{task}</li>
                          ))}
                        </ul>
                      )}

                      {recommendationSummary.work_order.required_parts_or_tools?.length > 0 && (
                        <div className="wo-parts">
                          {recommendationSummary.work_order.required_parts_or_tools.map((part, i) => (
                            <span className="wo-part-tag" key={i}>
                              {part}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {recommendationSummary.confidence?.missing_information?.length > 0 && (
                    <div className="summary-box warning-box">
                      <h4>Missing Information</h4>
                      <ul className="missing-list">
                        {recommendationSummary.confidence.missing_information.map((info, i) => (
                          <li key={i}>{info}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <p className="empty-state empty-state--large">
                  <span className="empty-state-icon">🧠</span>
                  Generate the AI recommendation to populate the maintenance decision board.
                </p>
              )}
            </PanelCard>
          </section>

          <section className="dual-stage dual-stage--secondary">
            <PanelCard
              title="Predictive Maintenance Intelligence"
              subtitle="ML-based forecast for failure risk, health score, and remaining useful life."
              accent="predictive"
              icon="📈"
              badge={
                <span className="panel-badge ai-badge">
                  <span className="ai-sparkle">ML</span>
                  Forecast Engine
                </span>
              }
            >
              {analyticsResult ? (
                predictivePrediction ? (
                  <div className="analytics-panel">
                    <div className="aircraft-hero-card aircraft-hero-card--predictive">
                      <div className="aircraft-hero-card__badge">Forecast Active</div>
                      <div className="aircraft-hero-card__main">
                        <div className="aircraft-hero-card__icon">📈</div>
                        <div>
                          <h4>{predictivePrediction.aircraft_id} — Predictive Health Overview</h4>
                          <div className="aircraft-meta">
                            <span>🛬 Cycle {predictivePrediction.flight_cycle}</span>
                            <span>⚠ Risk: {predictivePrediction.risk_band}</span>
                            <span>🧠 ML Forecast Active</span>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="predictive-highlight-grid predictive-highlight-grid--inner">
                      {predictiveMetrics.map((metric) => (
                        <div className={`predictive-spotlight ${metric.accent}`} key={metric.label}>
                          <span className="predictive-spotlight__icon">{metric.icon}</span>
                          <span className="predictive-spotlight__label">{metric.label}</span>
                          <strong className="predictive-spotlight__value">{metric.value}</strong>
                          <small className="predictive-spotlight__sub">{metric.sub}</small>
                        </div>
                      ))}
                    </div>

                    <div className="status-banner">
                      <span className={`status-badge ${getRiskBadgeClass(predictivePrediction.risk_band)}`}>
                        <span className="badge-dot" />
                        {predictivePrediction.risk_band} RISK
                      </span>
                      <span className={`status-badge ${predictivePrediction.predicted_failure_label ? 'critical' : 'ok'}`}>
                        <span className="badge-dot" />
                        {predictivePrediction.predicted_failure_label
                          ? 'POTENTIAL FAILURE WITHIN HORIZON'
                          : 'NO FAILURE PREDICTED WITHIN HORIZON'}
                      </span>
                    </div>

                    {predictivePrediction.top_feature_snapshot && (
                      <div className="signal-list signal-list--board">
                        <h4>
                          Current Predictive Input Snapshot
                          <span className="signal-count">
                            {Object.keys(predictivePrediction.top_feature_snapshot).length} fields
                          </span>
                        </h4>

                        {Object.entries(predictivePrediction.top_feature_snapshot).map(([key, value]) => (
                          <div key={key} className="signal-row">
                            <span className="signal-name">{key.replace(/_/g, ' ')}</span>
                            <span className="signal-value" style={{ gridColumn: 'span 3', textAlign: 'right' }}>
                              {String(value)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="empty-state">
                    <span className="empty-state-icon">📈</span>
                    Predictive maintenance output is not available in the analytics response.
                  </p>
                )
              ) : (
                <p className="empty-state">
                  <span className="empty-state-icon">📈</span>
                  Generate analytics to unlock predictive health scoring, failure probability, and RUL forecast.
                </p>
              )}
            </PanelCard>

            <PanelCard
              title="Model Evaluation Snapshot"
              subtitle="Reference metrics from the trained production model and predictive reliability indicators."
              accent="evaluation"
              icon="🧪"
            >
              {analyticsResult ? (
                predictiveEvaluation ? (
                  <div className="recommendation-panel">
                    <div className="info-row">
                      <div className="info-card">
                        <span className="info-label">Classification Accuracy</span>
                        <span className="info-value">
                          {predictiveClassificationMetrics?.accuracy != null
                            ? `${(predictiveClassificationMetrics.accuracy * 100).toFixed(1)}%`
                            : 'N/A'}
                        </span>
                        <span className="info-sub">
                          ROC-AUC:{' '}
                          {predictiveClassificationMetrics?.roc_auc != null
                            ? predictiveClassificationMetrics.roc_auc.toFixed(3)
                            : 'N/A'}
                        </span>
                        <span className="info-sub">
                          F1:{' '}
                          {predictiveClassificationMetrics?.f1_score != null
                            ? predictiveClassificationMetrics.f1_score.toFixed(3)
                            : 'N/A'}
                        </span>
                      </div>

                      <div className="info-card">
                        <span className="info-label">Failure Detection Quality</span>
                        <span className="info-value">
                          {predictiveClassificationMetrics?.recall != null
                            ? `${(predictiveClassificationMetrics.recall * 100).toFixed(1)}%`
                            : 'N/A'}
                        </span>
                        <span className="info-sub">
                          Precision:{' '}
                          {predictiveClassificationMetrics?.precision != null
                            ? predictiveClassificationMetrics.precision.toFixed(3)
                            : 'N/A'}
                        </span>
                        <span className="info-sub">
                          Balanced Acc.:{' '}
                          {predictiveClassificationMetrics?.balanced_accuracy != null
                            ? predictiveClassificationMetrics.balanced_accuracy.toFixed(3)
                            : 'N/A'}
                        </span>
                      </div>
                    </div>

                    <div className="info-row">
                      <div className="info-card">
                        <span className="info-label">RUL Regression Fit</span>
                        <span className="info-value">
                          {predictiveRegressionMetrics?.r2_score != null
                            ? predictiveRegressionMetrics.r2_score.toFixed(3)
                            : 'N/A'}
                        </span>
                        <span className="info-sub">
                          Explained Variance:{' '}
                          {predictiveRegressionMetrics?.explained_variance != null
                            ? predictiveRegressionMetrics.explained_variance.toFixed(3)
                            : 'N/A'}
                        </span>
                      </div>

                      <div className="info-card">
                        <span className="info-label">RUL Error Range</span>
                        <span className="info-value">
                          {predictiveRegressionMetrics?.rmse != null
                            ? predictiveRegressionMetrics.rmse.toFixed(2)
                            : 'N/A'}
                        </span>
                        <span className="info-sub">
                          MAE:{' '}
                          {predictiveRegressionMetrics?.mae != null
                            ? predictiveRegressionMetrics.mae.toFixed(2)
                            : 'N/A'}
                        </span>
                        <span className="info-sub">RMSE in predicted cycles</span>
                      </div>
                    </div>

                    <div className="summary-box">
                      <h4>Interpretation</h4>
                      <p>
                        This predictive block complements deterministic engineering analytics by estimating
                        short-horizon failure likelihood and remaining useful life from historical sensor behavior.
                        Use the classification metrics to judge failure-alert quality and the regression metrics
                        to judge RUL forecast reliability.
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="empty-state">
                    <span className="empty-state-icon">🧪</span>
                    Model evaluation details are not available yet.
                  </p>
                )
              ) : (
                <p className="empty-state">
                  <span className="empty-state-icon">🧪</span>
                  Upload a flight dataset to view predictive model quality indicators.
                </p>
              )}
            </PanelCard>
          </section>
        </main>
      </div>
    </div>
  );
}

export default App;