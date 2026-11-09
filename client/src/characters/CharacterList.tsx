import { useState } from 'react';
import type { RoomState } from '../../../shared/protocol.ts';
import type { GameStore } from '../game.ts';
import { CharacterScreen } from './CharacterScreen.tsx';

/** The DM's list of every character in the campaign: open, hand to a player, or make a new one. */
export function CharacterList({ store, state }: { store: GameStore; state: RoomState }) {
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const players = state.members.filter((m) => m.role === 'player');
  const opened = open && open !== 'new' ? (state.characters.find((c) => c.id === open) ?? null) : null;

  return (
    <div>
      {state.characters.length === 0 && <p className="hint">No characters yet. Players create their own on their phone, or you can make pre-made ones.</p>}
      <ul className="list">
        {state.characters.map((c) => (
          <li key={c.id}>
            <div className="grow">
              <button className="link" onClick={() => setOpen(c.id)}>
                <strong>{c.name}</strong>
              </button>
              <div className="hint">{c.summary.classLine} · HP {c.hp.current}/{c.hp.max}</div>
            </div>
            <select
              className="compact-select"
              value={c.ownerId && players.some((p) => p.id === c.ownerId) ? c.ownerId : ''}
              onChange={(e) =>
                store.request('character:assign', { id: c.id, memberId: e.target.value || null }).then(() => setError(null), (err: Error) => setError(err.message))
              }
              aria-label={`Who plays ${c.name}`}
            >
              <option value="">{c.ownerId ? 'Player not here' : 'Nobody'}</option>
              {players.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
      <button className="button block" onClick={() => setOpen('new')}>New pre-made character</button>
      {open && (open === 'new' || opened) && (
        <CharacterScreen store={store} character={opened} editable onClose={() => setOpen(null)} />
      )}
    </div>
  );
}
