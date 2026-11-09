export function Home() {
  return (
    <main className="page home">
      <h1 className="title">dnd</h1>
      <p className="subtitle">A digital tabletop for your table.</p>
      <div className="choices">
        <a className="choice" href="/table">
          <span className="choice-icon" aria-hidden>🗺️</span>
          <strong>Main Screen</strong>
          <span>Use this device as the shared map in the middle of the table.</span>
        </a>
        <a className="choice" href="/join">
          <span className="choice-icon" aria-hidden>🛡️</span>
          <strong>Join as player</strong>
          <span>Use this phone or tablet for your character.</span>
        </a>
        <a className="choice" href="/dm">
          <span className="choice-icon" aria-hidden>📜</span>
          <strong>Join as Dungeon Master</strong>
          <span>Control the game from this device.</span>
        </a>
      </div>
    </main>
  );
}
