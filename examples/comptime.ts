/// <reference path="../types/udon.d.ts" />

function buildTable(): uint[] {
  const values: uint[] = [0, 0, 0, 0];
  for (let index: int = 0; index < values.length; index++) {
    values[index] = (index as uint) * 2;
  }
  return values;
}

const table: uint[] = comptime((): uint[] => buildTable());

export class ComptimeExample extends UdonBehaviour {
  @comptime
  private makeId(category: uint, index: uint): uint {
    return category * 100 + index;
  }

  public override Start(): void {
    Debug.log(table[2]);
    Debug.log(this.makeId(1, 23));
  }
}
