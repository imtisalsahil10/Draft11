import { useEffect, useMemo, useState } from 'react';
import { duplicatePairId } from '@shared/identity-review.js';

const SESSION_KEY = 'draft11-review-session';

function sessionId() {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = `unauthenticated-${crypto.randomUUID()}`;
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || 'The review server did not save that change.');
    error.status = response.status;
    error.current = body.current || null;
    throw error;
  }
  return body;
}

function CardFace({ record }) {
  if (!record) return <p>This record is not in the catalogue.</p>;
  return (
    <article style={{ background: 'var(--color-surface)', padding: '1rem', borderRadius: 12 }}>
      {record.reviewImage || record.imagePath ? (
        <img src={record.reviewImage || record.imagePath} alt="" width="160" />
      ) : (
        <p>No local preview. Source file: {record.sourceImage}</p>
      )}
      <p>Original name: {record.ocrName || record.extractedName}</p>
      <p>Suggested identity: {record.proposedCanonicalName || 'None'}</p>
      <p>Overall: {record.overall ?? 'Unknown'} · Position: {record.position || 'Unknown'}</p>
      <p>Nationality: {record.nationality?.value || 'Unknown'} ({record.nationality?.status || 'unknown'})</p>
      <p>Club: {record.club?.value || 'Unknown'} ({record.club?.status || 'unknown'})</p>
      <p>League: {record.league?.value || 'Unknown'} ({record.league?.status || 'unknown'})</p>
      <p>Confidence: {record.matchConfidence ?? 'Unknown'}</p>
      <p>{record.reason}</p>
      <ul>
        {(record.evidence || []).map((item) => <li key={item}>{item}</li>)}
      </ul>
    </article>
  );
}

export default function IdentityReviewPage() {
  const [records, setRecords] = useState([]);
  const [duplicates, setDuplicates] = useState([]);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('manual_review');
  const [selectedId, setSelectedId] = useState('');
  const [pairId, setPairId] = useState('');
  const [decisions, setDecisions] = useState({});
  const [pairDecisions, setPairDecisions] = useState({});
  const [correction, setCorrection] = useState('');
  const session = sessionId();

  useEffect(() => {
    fetch('/identity-review.json')
      .then((response) => {
        if (!response.ok) throw new Error('The review file is not available yet.');
        return response.json();
      })
      .then((data) => {
        setRecords(data.records || []);
        setDuplicates(data.duplicates || []);
        setSummary(data.summary || null);
      })
      .catch((reason) => setError(reason.message));
    api('/api/identity-review/decisions')
      .then((data) => {
        setDecisions(data.decisions || {});
        setPairDecisions(data.duplicateDecisions || {});
      })
      .catch((reason) => setError(reason.message));
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return records.filter((record) => {
      const decision = decisions[record.playerId]?.decision;
      if (status === 'rejected') {
        if (decision !== 'reject') return false;
      } else if (status !== 'all' && status !== 'duplicates' && record.status !== status) {
        return false;
      }
      if (!needle) return true;
      return `${record.extractedName} ${record.ocrName} ${record.proposedCanonicalName} ${record.playerId}`
        .toLowerCase()
        .includes(needle);
    });
  }, [records, decisions, query, status]);

  const visiblePairs = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return duplicates.filter((pair) => {
      if (!needle) return true;
      return `${pair.extractedName} ${pair.otherExtractedName} ${pair.playerId} ${pair.otherPlayerId}`
        .toLowerCase()
        .includes(needle);
    });
  }, [duplicates, query]);

  const selected = records.find((record) => record.playerId === selectedId) || visible[0] || null;
  const selectedPair = visiblePairs.find((pair) => duplicatePairId(pair.playerId, pair.otherPlayerId) === pairId) || visiblePairs[0] || null;

  function choose(record) {
    setSelectedId(record.playerId);
    setCorrection(decisions[record.playerId]?.correctedName || record.proposedCanonicalName || '');
  }

  function nextRecord() {
    const index = visible.findIndex((record) => record.playerId === selected?.playerId);
    const following = visible[index + 1] || visible[0];
    if (following) choose(following);
  }

  async function decide(decision) {
    if (!selected) return;
    const current = decisions[selected.playerId];
    try {
      const saved = await api(`/api/identity-review/decisions/${encodeURIComponent(selected.playerId)}`, {
        method: 'PUT',
        body: JSON.stringify({
          decision,
          correctedName: correction,
          ocrName: selected.ocrName || selected.extractedName,
          proposedCanonicalName: selected.proposedCanonicalName,
          expectedRevision: current?.revision || 0,
          sessionId: session
        })
      });
      setDecisions((previous) => ({ ...previous, [saved.playerId]: saved }));
      setError('');
      nextRecord();
    } catch (reason) {
      if (reason.current) {
        setDecisions((previous) => ({ ...previous, [selected.playerId]: reason.current }));
      }
      setError(reason.message);
    }
  }

  async function undo() {
    if (!selected) return;
    const current = decisions[selected.playerId];
    try {
      const saved = await api(`/api/identity-review/decisions/${encodeURIComponent(selected.playerId)}/undo`, {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: current?.revision || 0, sessionId: session })
      });
      setDecisions((previous) => ({ ...previous, [saved.playerId]: saved }));
      setCorrection(saved.correctedName || selected.proposedCanonicalName || '');
      setError('');
    } catch (reason) {
      setError(reason.message);
    }
  }

  async function undoPair() {
    if (!selectedPair) return;
    const id = duplicatePairId(selectedPair.playerId, selectedPair.otherPlayerId);
    const current = pairDecisions[id];
    try {
      const saved = await api(`/api/identity-review/duplicates/${encodeURIComponent(id)}/undo`, {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: current?.revision || 0, sessionId: session })
      });
      setPairDecisions((previous) => ({ ...previous, [saved.pairId]: saved }));
      setError('');
    } catch (reason) {
      setError(reason.message);
    }
  }

  async function decidePair(decision) {
    if (!selectedPair) return;
    const id = duplicatePairId(selectedPair.playerId, selectedPair.otherPlayerId);
    const current = pairDecisions[id];
    try {
      const saved = await api(`/api/identity-review/duplicates/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          decision,
          playerId: selectedPair.playerId,
          otherPlayerId: selectedPair.otherPlayerId,
          expectedRevision: current?.revision || 0,
          sessionId: session
        })
      });
      setPairDecisions((previous) => ({ ...previous, [saved.pairId]: saved }));
      setError('');
      const index = visiblePairs.findIndex((pair) => duplicatePairId(pair.playerId, pair.otherPlayerId) === id);
      const following = visiblePairs[index + 1] || visiblePairs[0];
      if (following) setPairId(duplicatePairId(following.playerId, following.otherPlayerId));
    } catch (reason) {
      if (reason.current) setPairDecisions((previous) => ({ ...previous, [id]: reason.current }));
      setError(reason.message);
    }
  }

  async function downloadExport() {
    const payload = await api('/api/identity-review/export');
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'identity-review-store.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  async function backup() {
    try {
      const result = await api('/api/identity-review/backup', { method: 'POST', body: '{}' });
      setError(`Backup saved: ${result.file}`);
    } catch (reason) {
      setError(reason.message);
    }
  }

  const savedDecision = selected ? decisions[selected.playerId] : null;
  const savedPair = selectedPair
    ? pairDecisions[duplicatePairId(selectedPair.playerId, selectedPair.otherPlayerId)]
    : null;

  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: '1.5rem', color: 'var(--color-text)' }}>
      <h1 style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.04em' }}>Identity review</h1>
      <p style={{ color: 'var(--color-muted)' }}>
        Decisions are saved on this server. The reviewer is not signed in. Session {session}.
        Original OCR names stay on the card record.
        {summary ? ` ${summary.totalIdentities} identities, ${summary.verified} verified by the reference check.` : ''}
      </p>
      {error ? <p>{error}</p> : null}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        <input
          aria-label="Search players"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name or id"
          style={{ flex: 1, minWidth: 180, padding: '0.6rem' }}
        />
        <select aria-label="Review filter" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="high_confidence_candidate">High-confidence candidates</option>
          <option value="manual_review">Manual review</option>
          <option value="ambiguous">Ambiguous identities</option>
          <option value="unidentified">Unidentified players</option>
          <option value="duplicates">Possible duplicates</option>
          <option value="verified">Already verified</option>
          <option value="rejected">Rejected</option>
          <option value="all">All</option>
        </select>
        <button type="button" onClick={downloadExport}>Export</button>
        <button type="button" onClick={backup}>Backup</button>
      </div>
      {status === 'duplicates' ? (
        <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: '1rem' }}>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: '70vh', overflow: 'auto' }}>
            {visiblePairs.map((pair) => {
              const id = duplicatePairId(pair.playerId, pair.otherPlayerId);
              return (
                <li key={id}>
                  <button type="button" onClick={() => setPairId(id)} style={{ width: '100%', textAlign: 'left', padding: '0.45rem 0.3rem', color: 'inherit', border: 0, background: selectedPair && id === duplicatePairId(selectedPair.playerId, selectedPair.otherPlayerId) ? 'var(--color-surface-raised)' : 'transparent' }}>
                    {pair.extractedName} / {pair.otherExtractedName}
                  </button>
                </li>
              );
            })}
          </ul>
          {selectedPair ? (
            <section>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <CardFace record={selectedPair.left} />
                <CardFace record={selectedPair.right} />
              </div>
              <p>{selectedPair.supportingEvidence}</p>
              <p>Saved decision: {savedPair?.decision || 'unresolved'}</p>
              {savedPair?.mergePlan ? (
                <p>Merge plan: planned, reversible, and not executed. Both player IDs stay in the catalogue.</p>
              ) : null}
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.8rem' }}>
                <button type="button" onClick={() => decidePair('same')}>Same player</button>
                <button type="button" onClick={() => decidePair('different')}>Different players</button>
                <button type="button" onClick={() => decidePair('unresolved')}>Leave unresolved</button>
                <button type="button" onClick={undoPair}>Undo</button>
              </div>
            </section>
          ) : null}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: '1rem' }}>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: '70vh', overflow: 'auto' }}>
            {visible.map((record) => (
              <li key={record.playerId}>
                <button type="button" onClick={() => choose(record)} style={{ width: '100%', textAlign: 'left', padding: '0.45rem 0.3rem', color: 'inherit', border: 0, background: selected?.playerId === record.playerId ? 'var(--color-surface-raised)' : 'transparent' }}>
                  {record.extractedName || record.playerId}
                  <span style={{ color: 'var(--color-muted)' }}> {decisions[record.playerId]?.decision || record.status}</span>
                </button>
              </li>
            ))}
          </ul>
          {selected ? (
            <section>
              <CardFace record={selected} />
              <p>Saved decision: {savedDecision?.decision || 'unresolved'}</p>
              {savedDecision?.correctedName ? <p>Corrected name: {savedDecision.correctedName}</p> : null}
              <label>
                Correction
                <input aria-label="Corrected name" value={correction} onChange={(event) => setCorrection(event.target.value)} style={{ marginLeft: '0.5rem' }} />
              </label>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.8rem', flexWrap: 'wrap' }}>
                <button type="button" onClick={() => decide('confirm')}>Confirm</button>
                <button type="button" onClick={() => decide('correct')}>Correct</button>
                <button type="button" onClick={() => decide('reject')}>Reject</button>
                <button type="button" onClick={() => decide('unresolved')}>Leave unresolved</button>
                <button type="button" onClick={undo}>Undo</button>
                <button type="button" onClick={nextRecord}>Next</button>
              </div>
            </section>
          ) : null}
        </div>
      )}
    </main>
  );
}
