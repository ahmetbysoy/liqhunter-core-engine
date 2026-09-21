import { useEffect, useMemo, useState } from 'react';
import './styles/app.css';

const REPORT_PATHS = [
  'latest-report.json',
  'artifacts/latest-report.json',
];

const STATUS_PATHS = ['status.json'];

export default function App() {
  const [report, setReport] = useState(null);
  const [runStatus, setRunStatus] = useState(null);
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const statusPayload = await firstJson(STATUS_PATHS);
      if (!cancelled) setRunStatus(statusPayload);

      const reportPayload = await firstJson(REPORT_PATHS);
      if (cancelled) return;

      if (reportPayload) {
        setReport(reportPayload);
        setStatus('ready');
        return;
      }
      setStatus(statusPayload ? 'skipped' : 'missing');
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const best = report?.best;
  const verdict = useMemo(() => describeVerdict(report, runStatus, status), [report, runStatus, status]);

  return (
    <main className="shell">
      <header className="top">
        <div>
          <p className="eyebrow">LiqHunter Core Engine</p>
          <h1>Microstructure Replay & Optimization</h1>
        </div>
        <span className={`pill ${status}`}>{statusLabel(status)}</span>
      </header>

      {status === 'loading' && <p className="muted">Loading report…</p>}
      {status === 'missing' && (
        <p className="muted">
          No report yet. Run the Replay &amp; Optimization Engine workflow to generate one.
        </p>
      )}

      {status === 'ready' && report && (
        <>
          <section className="verdict">
            <h2 className={verdict.tone}>{verdict.title}</h2>
            <p>{verdict.detail}</p>
          </section>

          <section className="grid">
            <Card label="Symbol" value={report.symbol} />
            <Card
              label="Best threshold"
              value={best ? Number(best.entryThreshold).toFixed(2) : '—'}
            />
            <Card
              label="Out-of-sample confirmed"
              value={report.confirmed ? 'YES' : 'NO'}
              tone={report.confirmed ? 'good' : 'warn'}
            />
            <Card label="Train trades" value={formatInt(report.trainTradeCount)} />
            <Card label="Test trades" value={formatInt(report.testTradeCount)} />
            <Card
              label="Min settled requirement"
              value={formatInt(report.minSettledTrades)}
            />
          </section>

          <section className="tableWrap">
            <h3>Threshold scan</h3>
            <table>
              <thead>
                <tr>
                  <th>Threshold</th>
                  <th>Train settled</th>
                  <th>Train win rate</th>
                  <th>Train Wilson</th>
                  <th>Test settled</th>
                  <th>Test win rate</th>
                  <th>Test net bps</th>
                  <th>Eligible</th>
                </tr>
              </thead>
              <tbody>
                {(report.candidates ?? []).map((candidate) => (
                  <tr
                    key={candidate.entryThreshold}
                    className={
                      best && candidate.entryThreshold === best.entryThreshold ? 'selected' : ''
                    }
                  >
                    <td>{Number(candidate.entryThreshold).toFixed(2)}</td>
                    <td>{formatInt(candidate.train.settledCount)}</td>
                    <td>{formatPct(candidate.train.winRate)}</td>
                    <td>{Number(candidate.train.wilsonLowerBound).toFixed(4)}</td>
                    <td>{formatInt(candidate.test.settledCount)}</td>
                    <td>{formatPct(candidate.test.winRate)}</td>
                    <td className={candidate.test.netReturnSumBps >= 0 ? 'good' : 'bad'}>
                      {Number(candidate.test.netReturnSumBps).toFixed(2)}
                    </td>
                    <td>{candidate.eligible ? 'yes' : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <footer className="foot">
            <p>{report.note}</p>
            <p className="muted">
              Costs modelled: taker fee per side plus slippage. Signals settle only on trades
              after the decision timestamp.
            </p>
          </footer>
        </>
      )}
    </main>
  );
}

function Card({ label, value, tone }) {
  return (
    <div className="card">
      <span className="cardLabel">{label}</span>
      <strong className={tone ?? ''}>{value}</strong>
    </div>
  );
}

function describeVerdict(report, runStatus, status) {
  if (status === 'skipped') {
    return {
      title: 'RUN SKIPPED: DATA SOURCE UNAVAILABLE',
      detail:
        runStatus?.detail
        ?? 'The engine could not reach the exchange from the runner location. This is an environment limit, not an engine failure.',
      tone: 'warn',
    };
  }
  if (!report) {
    return { title: 'NO DATA', detail: 'Waiting for a report.', tone: 'warn' };
  }
  if (report.confirmed) {
    return {
      title: 'EDGE CONFIRMED OUT-OF-SAMPLE',
      detail:
        'The selected threshold stayed positive on data it was not tuned on. This is a measurement, not a profit guarantee.',
      tone: 'good',
    };
  }
  return {
    title: 'NO CONFIRMED EDGE',
    detail:
      'No threshold survived out-of-sample confirmation. Do not trade this configuration. The engine produced no signal worth acting on.',
    tone: 'bad',
  };
}

function statusLabel(status) {
  if (status === 'ready') return 'REPORT LOADED';
  if (status === 'skipped') return 'RUN SKIPPED';
  if (status === 'missing') return 'NO REPORT';
  return 'LOADING';
}

async function firstJson(paths) {
  for (const path of paths) {
    try {
      const response = await fetch(`${path}?t=${Date.now()}`);
      if (!response.ok) continue;
      return await response.json();
    } catch {
      continue;
    }
  }
  return null;
}

function formatInt(value) {
  if (value === undefined || value === null) return '—';
  return Number(value).toLocaleString('en-US');
}

function formatPct(value) {
  if (value === undefined || value === null) return '—';
  return `${(Number(value) * 100).toFixed(1)}%`;
}
