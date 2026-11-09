export function Home() {
  return (
    <main className="page home">
      <h1 className="title">dnd</h1>
      <p className="subtitle">A digital tabletop for your table.</p>
      <nav className="menu">
        <a className="menu-item" href="/table">
          <strong>Main Screen</strong>
          <span>Use this device as the shared map in the middle of the table.</span>
        </a>
        <a className="menu-item" href="/join">
          <strong>Join a game</strong>
          <span>As a player or as the Dungeon Master.</span>
        </a>
        <a className="menu-item" href="/settings">
          <strong>Settings</strong>
          <span>Distances (hexes, feet, metres) and appearance.</span>
        </a>
      </nav>
    </main>
  );
}
