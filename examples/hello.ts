/// <reference path="../types/udon.d.ts" />

/** Inspectorへ公開される値です。 */
export let message: string = "Hello from TypeScript!";

/** @sync linear */
export let speed: float = 2.5;

function doubled(value: float): float {
  return value * 2;
}

export function start(): void {
  Debug.log(message);
  const player: VRCPlayerApi = Networking.localPlayer;
  player.setWalkSpeed(doubled(speed));
}

export function onPlayerJoined(player: VRCPlayerApi): void {
  Debug.log(player.displayName);
}
