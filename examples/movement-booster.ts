/// <reference path="../types/udon.d.ts" />

/**
 * Interact でローカルプレイヤーの移動能力を切り替えるブースタースイッチ。
 * indicator には、ブースト中だけ表示したいランプ等を Inspector で割り当てます。
 */

/** ブースト中に表示するランプやパーティクル */
export let indicator: GameObject;

/** 通常時の移動設定 */
export let normalWalkSpeed: float = 2.0;
export let normalRunSpeed: float = 4.0;
export let normalJumpImpulse: float = 3.0;

/** ブースト時の移動設定 */
export let boostedWalkSpeed: float = 4.0;
export let boostedRunSpeed: float = 8.0;
export let boostedJumpImpulse: float = 6.0;

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

export function start(): void {
  applyMovement();
}

export function interact(): void {
  boosted = !boosted;
  applyMovement();
}

