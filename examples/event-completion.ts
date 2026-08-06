/// <reference path="../types/udon.d.ts" />

export class EventCompletionExample extends UdonBehaviour {
  public override Start(): void {
    Debug.log("started");
  }

  public override OnPlayerJoined(player: VRCPlayerApi): void {
    Debug.log(player.displayName);
  }

  public override InputJump(value: bool, args: UdonInputEventArgs): void {
    if (value) Debug.log(args);
  }

  public override OnDeserialization(result: DeserializationResult): void {
    Debug.log(result);
  }

  public override OnOwnershipRequest(
    requestingPlayer: VRCPlayerApi,
    requestedOwner: VRCPlayerApi
  ): bool {
    Debug.log(requestingPlayer.displayName);
    Debug.log(requestedOwner.displayName);
    return true;
  }
}
