/// <reference path="../types/udon.d.ts" />

const precomputed: uint = comptime((): uint => 6 * 7);

export class LegacyDecoratorExample extends UdonBehaviour {
  @udonVariable
  enabled: bool = false;

  @udonVariable({ sync: "linear" })
  speed: float = 2.5;

  @comptime
  private answer(): uint {
    return precomputed;
  }

  public override Start(): void {
    Debug.log(this.answer());
  }
}
