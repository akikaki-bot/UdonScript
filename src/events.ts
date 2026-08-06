import type { EventDefinition, EventParameter, UdonType } from "./model.js";

const playerType = "VRCSDKBaseVRCPlayerApi";

function parameter(name: string, symbol: string, type: UdonType): EventParameter {
  return { name, symbol, type };
}

function event(
  sourceName: string,
  parameters: EventParameter[] = [],
  description?: string,
  options: { assemblyName?: string; returns?: UdonType; returnSymbol?: string } = {}
): EventDefinition {
  return {
    sourceName,
    assemblyName: options.assemblyName ?? `_${sourceName}`,
    parameters,
    ...(options.returns ? { returns: options.returns } : {}),
    ...(options.returnSymbol ? { returnSymbol: options.returnSymbol } : {}),
    ...(description ? { description } : {})
  };
}

function playerEvent(sourceName: string, symbol: string, description: string): EventDefinition {
  return event(sourceName, [parameter("player", symbol, playerType)], description);
}

/** Built-in Udon callbacks used by both compilation and editor completion. */
export const events: readonly EventDefinition[] = [
  event("onEnable", [], "Behaviourが有効になったときに呼ばれます。"),
  event("start", [], "Behaviour開始時に一度呼ばれます。"),
  event("update", [], "フレームごとに呼ばれます。"),
  event("lateUpdate", [], "Update後にフレームごとに呼ばれます。"),
  event("fixedUpdate", [], "物理更新ごとに呼ばれます。"),
  event("postLateUpdate", [], "IK計算後、フレーム終端付近で呼ばれます。"),
  event("onDisable", [], "Behaviourが無効になったときに呼ばれます。"),

  event("interact", [], "ローカルプレイヤーがこのGameObjectを操作したときに呼ばれます。", { assemblyName: "_interact" }),
  event("onPickup", [], "ローカルプレイヤーがこのオブジェクトを拾ったときに呼ばれます。"),
  event("onDrop", [], "ローカルプレイヤーがこのオブジェクトを離したときに呼ばれます。"),
  event("onPickupUseDown", [], "Pickup使用ボタンを押したときに呼ばれます。"),
  event("onPickupUseUp", [], "Pickup使用ボタンを離したときに呼ばれます。"),

  playerEvent("onPlayerJoined", "playerJoinedPlayer", "プレイヤーがインスタンスへ参加したときに呼ばれます。"),
  playerEvent("onPlayerLeft", "playerLeftPlayer", "プレイヤーがインスタンスから退出したときに呼ばれます。"),
  playerEvent("onPlayerRestored", "playerRestoredPlayer", "プレイヤーの永続データ読み込み完了後に呼ばれます。"),
  playerEvent("onPlayerRespawn", "playerRespawnPlayer", "ローカルプレイヤーがリスポーンしたときに呼ばれます。"),
  playerEvent("onPlayerSuspendChanged", "playerSuspendChangedPlayer", "プレイヤーのsuspend状態が変化したときに呼ばれます。"),
  playerEvent("onAvatarChanged", "avatarChangedPlayer", "プレイヤーのAvatar読み込み完了時に呼ばれます。"),
  event("onAvatarEyeHeightChanged", [
    parameter("player", "avatarEyeHeightChangedPlayer", playerType),
    parameter("previousEyeHeight", "avatarEyeHeightChangedPrevEyeHeightAsMeters", "SystemSingle")
  ], "プレイヤーのAvatar眼高が変化したときに呼ばれます。"),

  playerEvent("onPlayerTriggerEnter", "playerTriggerEnterPlayer", "プレイヤーがTriggerへ入ったときに呼ばれます。"),
  playerEvent("onPlayerTriggerStay", "playerTriggerStayPlayer", "プレイヤーがTrigger内にいる間、毎フレーム呼ばれます。"),
  playerEvent("onPlayerTriggerExit", "playerTriggerExitPlayer", "プレイヤーがTriggerから出たときに呼ばれます。"),
  playerEvent("onPlayerCollisionEnter", "playerCollisionEnterPlayer", "プレイヤーがColliderへ入ったときに呼ばれます。"),
  playerEvent("onPlayerCollisionStay", "playerCollisionStayPlayer", "プレイヤーがCollider内にいる間、毎フレーム呼ばれます。"),
  playerEvent("onPlayerCollisionExit", "playerCollisionExitPlayer", "プレイヤーがColliderから出たときに呼ばれます。"),
  playerEvent("onPlayerParticleCollision", "playerParticleCollisionPlayer", "Particleがプレイヤーへ衝突したときに呼ばれます。"),
  event("onControllerColliderHitPlayer", [
    parameter("hit", "controllerColliderHitPlayerHit", "VRCSDK3ControllerColliderPlayerHit")
  ], "CharacterControllerがプレイヤーへ衝突したときに呼ばれます。"),

  event("onStationEntered", [parameter("player", "stationEnteredPlayer", playerType)], "ローカルプレイヤーがStationへ入ったときに呼ばれます。"),
  event("onStationExited", [parameter("player", "stationExitedPlayer", playerType)], "ローカルプレイヤーがStationから出たときに呼ばれます。"),

  event("onOwnershipRequest", [
    parameter("requestingPlayer", "ownershipRequestRequestingPlayer", playerType),
    parameter("requestedOwner", "ownershipRequestRequestedOwner", playerType)
  ], "所有権移譲要求を受けたときに呼ばれます。trueを返すと許可します。", {
    returns: "SystemBoolean",
    returnSymbol: "__returnValue"
  }),
  playerEvent("onOwnershipTransferred", "ownershipTransferredPlayer", "オブジェクトの所有者が変化したときに呼ばれます。"),
  playerEvent("onMasterTransferred", "masterTransferredNewMaster", "インスタンスマスターが変化したときに呼ばれます。"),
  event("onPreSerialization", [], "同期変数をシリアライズする直前に呼ばれます。"),
  event("onPostSerialization", [
    parameter("result", "postSerializationResult", "VRCUdonCommonSerializationResult")
  ], "同期変数の送信試行後に呼ばれます。"),
  event("onDeserialization", [], "同期変数を受信したときに呼ばれます。"),
  event("onDeserialization", [
    parameter("result", "deserializationResult", "VRCUdonCommonDeserializationResult")
  ], "同期変数を受信したとき、時刻情報とともに呼ばれます。"),
  event("onSpawn", [], "Object Poolからspawnされたときに呼ばれる非推奨イベントです。"),

  event("onVideoReady", [], "Video Playerが動画を読み込んだときに呼ばれます。"),
  event("onVideoStart", [], "Video Playerが停止状態から再生を開始したときに呼ばれます。"),
  event("onVideoPlay", [], "Video Playerが再生を開始したときに呼ばれます。"),
  event("onVideoPause", [], "Video Playerが一時停止したときに呼ばれます。"),
  event("onVideoLoop", [], "Video Playerがループ末尾へ到達したときに呼ばれます。"),
  event("onVideoEnd", [], "Video Playerの再生が終了したときに呼ばれます。"),
  event("onVideoError", [parameter("videoError", "videoErrorVideoError", "VRCSDK3ComponentsVideoVideoError")], "Video Playerでエラーが起きたときに呼ばれます。"),

  event("onImageLoadSuccess", [parameter("result", "imageLoadSuccessResult", "VRCSDK3ImageIVRCImageDownload")], "画像の読み込みに成功したときに呼ばれます。"),
  event("onImageLoadError", [parameter("result", "imageLoadErrorResult", "VRCSDK3ImageIVRCImageDownload")], "画像の読み込みに失敗したときに呼ばれます。"),
  event("onStringLoadSuccess", [parameter("result", "stringLoadSuccessResult", "VRCSDK3StringLoadingIVRCStringDownload")], "文字列の読み込みに成功したときに呼ばれます。"),
  event("onStringLoadError", [parameter("result", "stringLoadErrorResult", "VRCSDK3StringLoadingIVRCStringDownload")], "文字列の読み込みに失敗したときに呼ばれます。"),
  event("onAsyncGpuReadbackComplete", [parameter("request", "asyncGpuReadbackCompleteRequest", "VRCSDK3RenderingVRCAsyncGPUReadbackRequest")], "非同期GPU readback完了時に呼ばれます。"),

  event("inputJump", [parameter("value", "inputJumpValue", "SystemBoolean"), parameter("args", "inputJumpArgs", "VRCUdonCommonUdonInputEventArgs")], "Jump入力時に呼ばれます。"),
  event("inputUse", [parameter("value", "inputUseValue", "SystemBoolean"), parameter("args", "inputUseArgs", "VRCUdonCommonUdonInputEventArgs")], "Use入力時に呼ばれます。"),
  event("inputGrab", [parameter("value", "inputGrabValue", "SystemBoolean"), parameter("args", "inputGrabArgs", "VRCUdonCommonUdonInputEventArgs")], "Grab入力時に呼ばれます。"),
  event("inputDrop", [parameter("value", "inputDropValue", "SystemBoolean"), parameter("args", "inputDropArgs", "VRCUdonCommonUdonInputEventArgs")], "Drop入力時に呼ばれます。"),
  event("inputMoveHorizontal", [parameter("value", "inputMoveHorizontalValue", "SystemSingle"), parameter("args", "inputMoveHorizontalArgs", "VRCUdonCommonUdonInputEventArgs")], "水平移動入力時に呼ばれます。"),
  event("inputMoveVertical", [parameter("value", "inputMoveVerticalValue", "SystemSingle"), parameter("args", "inputMoveVerticalArgs", "VRCUdonCommonUdonInputEventArgs")], "垂直移動入力時に呼ばれます。"),
  event("inputLookHorizontal", [parameter("value", "inputLookHorizontalValue", "SystemSingle"), parameter("args", "inputLookHorizontalArgs", "VRCUdonCommonUdonInputEventArgs")], "水平視点入力時に呼ばれます。"),
  event("inputLookVertical", [parameter("value", "inputLookVerticalValue", "SystemSingle"), parameter("args", "inputLookVerticalArgs", "VRCUdonCommonUdonInputEventArgs")], "垂直視点入力時に呼ばれます。"),

  event("midiNoteOn", [parameter("channel", "midiNoteOnChannel", "SystemInt32"), parameter("number", "midiNoteOnNumber", "SystemInt32"), parameter("velocity", "midiNoteOnVelocity", "SystemInt32")], "MIDI Note On受信時に呼ばれます。"),
  event("midiNoteOff", [parameter("channel", "midiNoteOffChannel", "SystemInt32"), parameter("number", "midiNoteOffNumber", "SystemInt32"), parameter("velocity", "midiNoteOffVelocity", "SystemInt32")], "MIDI Note Off受信時に呼ばれます。"),
  event("midiControlChange", [parameter("channel", "midiControlChangeChannel", "SystemInt32"), parameter("number", "midiControlChangeNumber", "SystemInt32"), parameter("value", "midiControlChangeValue", "SystemInt32")], "MIDI Control Change受信時に呼ばれます。"),

  playerEvent("onPersistenceUsageUpdated", "persistenceUsageUpdatedPlayer", "永続ストレージ使用量が更新されたときに呼ばれます。"),
  playerEvent("onPlayerDataStorageExceeded", "playerDataStorageExceededPlayer", "Player Data容量を超えたときに呼ばれます。"),
  playerEvent("onPlayerDataStorageWarning", "playerDataStorageWarningPlayer", "Player Data容量上限へ近づいたときに呼ばれます。"),
  playerEvent("onPlayerObjectStorageExceeded", "playerObjectStorageExceededPlayer", "Player Object容量を超えたときに呼ばれます。"),
  playerEvent("onPlayerObjectStorageWarning", "playerObjectStorageWarningPlayer", "Player Object容量上限へ近づいたときに呼ばれます。"),
  event("onPlayerDataUpdated", [
    parameter("player", "playerDataUpdatedPlayer", playerType),
    parameter("infos", "playerDataUpdatedInfos", "VRCSDK3PersistencePlayerDataInfoArray")
  ], "Player Dataが更新または受信されたフレーム終端で呼ばれます。"),
  event("onScreenUpdate", [parameter("data", "screenUpdateData", "VRCSDK3PlatformScreenUpdateData")], "モバイル画面状態が更新されたときに呼ばれます。"),
  event("onInputMethodChanged", [parameter("inputMethod", "inputMethodChangedInputMethod", "VRCSDKBaseVRCInputMethod")], "入力デバイス方式が変わったときに呼ばれます。"),
  event("onLanguageChanged", [parameter("language", "languageChangedLanguage", "SystemString")], "表示言語が変わったときに呼ばれます。"),
  event("onVRCPlusMassGift", [parameter("gifter", "vrcPlusMassGiftGifter", playerType), parameter("numGifts", "vrcPlusMassGiftNumGifts", "SystemInt32")], "Gift Dropが発生したときに呼ばれます。"),
  event("onVRCCameraSettingsChanged", [parameter("camera", "vrcCameraSettingsChangedCamera", "VRCSDK3RenderingVRCCameraSettings")], "VRChat Camera設定が変化したときに呼ばれます。"),
  event("onVRCQualitySettingsChanged", [], "VRChat Graphics品質設定が変化したときに呼ばれます。")
];

export const eventsBySourceName = new Map<string, EventDefinition[]>();
for (const definition of events) {
  const definitions = eventsBySourceName.get(definition.sourceName) ?? [];
  definitions.push(definition);
  eventsBySourceName.set(definition.sourceName, definitions);
}

/** Kept for consumers that only need the canonical variant. */
export const eventBySourceName = new Map(
  [...eventsBySourceName].map(([name, definitions]) => [name, definitions[0]!])
);
