export class DoorController extends UdonBehaviour {
  @udonVariable
  opened: bool = false;

  public Toggle(): bool {
    this.opened = !this.opened;
    return this.opened;
  }
}
