import { SEATS } from '../../shared/protocol.ts';
import type { Side } from '../../shared/protocol.ts';

/** How far to turn text on the Main Screen so it faces a player on that side. */
export const SIDE_ROTATION: Record<Side, number> = {
  bottom: 0,
  right: -90,
  top: 180,
  left: 90,
};

export function seatNumber(seat: string | null) {
  return SEATS.findIndex((s) => s.id === seat) + 1;
}
