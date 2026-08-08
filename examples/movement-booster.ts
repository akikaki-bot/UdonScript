/// <reference path="../types/udon.d.ts" />

/**
 * Interact でローカルプレイヤーの移動能力を切り替えるブースタースイッチ。
 * indicator には、ブースト中だけ表示したいランプ等を Inspector で割り当てます。
 */

/** ブースト中に表示するランプやパーティクル */
let indicator = udonVariable<GameObject>();

/** 通常時の移動設定 */
let normalWalkSpeed = udonVariable<float>(2.0);
let normalRunSpeed = udonVariable<float>(4.0);
let normalJumpImpulse = udonVariable<float>(3.0);

/** ブースト時の移動設定 */
let boostedWalkSpeed = udonVariable<float>(4.0);
let boostedRunSpeed = udonVariable<float>(8.0);
let boostedJumpImpulse = udonVariable<float>(6.0);

let boosted: bool = false;

function applyMovement(): void {
  const player: VRCPlayerApi = Networking.localPlayer;

  if (boosted) {
    player.setWalkSpeed(boostedWalkSpeed);
    player.setRunSpeed(boostedRunSpeed);
    player.setJumpImpulse(boostedJumpImpulse);
    indicator.setActive(true);
    Debug.log("Movement Booster: ON");
  } else {
    player.setWalkSpeed(normalWalkSpeed);
    player.setRunSpeed(normalRunSpeed);
    player.setJumpImpulse(normalJumpImpulse);
    indicator.setActive(false);
    Debug.log("Movement Booster: OFF");
  }
}

on("Start", () => {
  applyMovement();
});

on("Interact", () => {
  boosted = !boosted;
  applyMovement();
});
