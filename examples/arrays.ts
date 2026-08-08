/// <reference path="../types/udon.d.ts" />

export class ArrayExample extends UdonBehaviour {
  /** Inspectorで要素数と参照先を設定できます。 */
  public targets!: GameObject[];

  private scores: int[] = [10, 20, 30];

  public Start(): void {
    for (let index: int = 0; index < this.scores.length; index++) {
      Debug.log(this.scores[index]);
    }

    const buffer: int[] = new Array<int>(this.scores.length);
    buffer[0] = this.scores[0];
  }
}
