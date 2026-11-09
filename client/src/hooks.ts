import { useEffect, useState } from 'react';
import type { RoomState } from '../../shared/protocol.ts';
import { socket } from './socket.ts';

export function useConnected() {
  const [connected, setConnected] = useState(socket.connected);
  useEffect(() => {
    const on = () => setConnected(true);
    const off = () => setConnected(false);
    socket.on('connect', on);
    socket.on('disconnect', off);
    return () => {
      socket.off('connect', on);
      socket.off('disconnect', off);
    };
  }, []);
  return connected;
}

export function useRoomState() {
  const [state, setState] = useState<RoomState | null>(null);
  useEffect(() => {
    socket.on('room:state', setState);
    return () => {
      socket.off('room:state', setState);
    };
  }, []);
  return [state, setState] as const;
}

/**
 * Runs `rejoin` now and every time the connection comes back
 * (e.g. the phone was locked or the Wi-Fi dropped).
 */
export function useOnConnect(rejoin: () => void, deps: unknown[]) {
  useEffect(() => {
    if (socket.connected) rejoin();
    socket.on('connect', rejoin);
    return () => {
      socket.off('connect', rejoin);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
