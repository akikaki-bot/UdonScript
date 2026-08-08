/// <reference path="../types/udon.d.ts" />

/** Inspectorへ公開される値です。 */
let message = udonVariable<string>("Hello from TypeScript!");

let speed = udonVariable<float>(2.5, { sync: "linear" });

function doubled(value: float): float {
  return value * 2;
}

on("Start", () => {
  Debug.log(message);
  const player: VRCPlayerApi = Networking.localPlayer;
  player.setWalkSpeed(doubled(speed));
});

on("OnPlayerJoined", (player) => {
  Debug.log(player.displayName);
});
