import { useEffect, useRef, useState } from 'react';
import type { CampaignSummary, RoomState, SnapshotInfo } from '../../../shared/protocol.ts';
import type { GameStore } from '../game.ts';

const when = (t: number) =>
  new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * The DM's campaigns: pick or create one before starting, and while playing
 * make save points, go back to one, and download or upload a backup.
 */
export function CampaignPanel({ store, state }: { store: GameStore; state: RoomState }) {
  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [addKey, setAddKey] = useState('');
  const [choosing, setChoosing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const run = async <T,>(p: Promise<T>, ok?: string) => {
    try {
      const v = await p;
      setError(null);
      setMessage(ok ?? null);
      return v;
    } catch (e) {
      setError((e as Error).message);
      setMessage(null);
      return null;
    }
  };

  const refresh = () =>
    store.request('campaign:list', {}).then(
      (r) => {
        setCampaigns(r.campaigns);
        setCurrentKey(r.current);
      },
      (e: Error) => setError(e.message),
    );
  useEffect(() => {
    refresh();
  }, [state.campaign?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = campaigns?.find((c) => c.key === currentKey);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (await run(store.request('campaign:create', { name: newName }), 'Campaign created.')) {
      setNewName('');
      setChoosing(false);
    }
  }

  async function addByKey(e: React.FormEvent) {
    e.preventDefault();
    if (await run(store.request('campaign:add', { key: addKey }), 'Campaign added to this device.')) {
      setAddKey('');
      refresh();
    }
  }

  async function load(key: string) {
    if (state.phase === 'playing' && !confirm('Switch to this campaign? The current one is saved first.')) return;
    if (await run(store.request('campaign:load', { key }), 'Campaign loaded.')) setChoosing(false);
  }

  async function download() {
    const res = await run(store.request('campaign:export', {}));
    if (!res) return;
    const blob = new Blob([JSON.stringify(res.data, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${res.name.replace(/[^\w\- ]+/g, '').trim() || 'campaign'} ${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function upload(file: File) {
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      setError('That file could not be read.');
      return;
    }
    if (await run(store.request('campaign:import', { data }), 'Backup imported as a new campaign.')) setChoosing(false);
  }

  const showList = !state.campaign || choosing;

  return (
    <div className="campaign-panel" data-testid="campaign-panel">
      {state.campaign && !choosing && (
        <div className="current-campaign">
          <div className="row">
            <div className="grow">
              <div className="label">Campaign</div>
              <strong data-testid="campaign-name">{state.campaign.name}</strong>
              {current && <div className="hint">Saved {when(current.updatedAt)}</div>}
            </div>
            <button className="button small" onClick={() => setChoosing(true)}>Change</button>
          </div>
          {state.phase === 'playing' && <SavePoints store={store} onError={setError} onMessage={setMessage} />}
          <details className="more">
            <summary>More</summary>
            <button
              className="text-button"
              onClick={() => {
                const name = prompt('New name for the campaign', state.campaign!.name);
                if (name) run(store.request('campaign:rename', { name }), 'Renamed.');
              }}
            >
              Rename
            </button>
            <button className="text-button" onClick={download}>Download backup file</button>
            {current && (
              <p className="hint">
                Campaign key: <code data-testid="campaign-key">{current.key}</code>. Enter it on another device to run this campaign
                from there.
              </p>
            )}
          </details>
        </div>
      )}

      {showList && (
        <div className="campaign-list">
          {campaigns === null ? (
            <p className="hint">Loading campaigns…</p>
          ) : (
            campaigns.length > 0 && (
              <ul className="list">
                {campaigns.map((c) => (
                  <li key={c.key}>
                    <div className="grow">
                      <strong>{c.name}</strong>
                      <div className="hint">Last saved {when(c.updatedAt)}</div>
                    </div>
                    {c.key === currentKey ? (
                      <span className="hint">Open</span>
                    ) : (
                      <button className="button small" onClick={() => load(c.key)}>Open</button>
                    )}
                  </li>
                ))}
              </ul>
            )
          )}
          <form className="inline-form" onSubmit={create}>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New campaign name" maxLength={60} aria-label="New campaign name" />
            <button className="button">Create</button>
          </form>
          <details className="more">
            <summary>Open from another device or a backup</summary>
            <form className="inline-form" onSubmit={addByKey}>
              <input value={addKey} onChange={(e) => setAddKey(e.target.value.toUpperCase())} placeholder="Campaign key" maxLength={12} aria-label="Campaign key" />
              <button className="button">Add</button>
            </form>
            <button className="text-button" onClick={() => fileInput.current?.click()}>Upload a backup file…</button>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload(f);
                e.target.value = '';
              }}
            />
          </details>
          {state.campaign && (
            <button className="text-button" onClick={() => setChoosing(false)}>Cancel</button>
          )}
        </div>
      )}
      {message && <p className="ok">{message}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function SavePoints({
  store,
  onError,
  onMessage,
}: {
  store: GameStore;
  onError: (e: string | null) => void;
  onMessage: (m: string | null) => void;
}) {
  const [list, setList] = useState<SnapshotInfo[] | null>(null);
  const [name, setName] = useState('');
  const load = () => store.request('campaign:snapshots', {}).then((r) => setList(r.snapshots), (e: Error) => onError(e.message));
  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await store.request('campaign:snapshot', { name });
      setName('');
      onError(null);
      onMessage('Save point made.');
      load();
    } catch (err) {
      onError((err as Error).message);
    }
  }

  async function restore(s: SnapshotInfo) {
    if (!confirm(`Go back to "${s.name}"? The current situation is kept as a save point too.`)) return;
    try {
      await store.request('campaign:restore', { snapshotId: s.id });
      onError(null);
      onMessage(`Back at "${s.name}".`);
      load();
    } catch (err) {
      onError((err as Error).message);
    }
  }

  return (
    <div className="save-points">
      <p className="hint">Everything is saved automatically. Make a save point to be able to go back to this exact moment.</p>
      <form className="inline-form" onSubmit={save}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Save point name (optional)" maxLength={60} aria-label="Save point name" />
        <button className="button" data-testid="make-save-point">Save point</button>
      </form>
      {list && list.length > 0 && (
        <ul className="list compact">
          {list.slice(0, 12).map((s) => (
            <li key={s.id}>
              <div className="grow">
                <span>{s.name}</span>
                <div className="hint">{when(s.at)}{s.auto ? ' · automatic' : ''}</div>
              </div>
              <button className="button small" onClick={() => restore(s)}>Go back</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
