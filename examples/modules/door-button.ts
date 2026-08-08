import { DoorController } from "./door-controller.js";
import { twice } from "./math.js";

export class DoorButton extends UdonBehaviour {
  @udonVariable
  door!: DoorController;

  public override Interact(): void {
    Debug.log(twice(2.0));
    Debug.log(this.door.Toggle());
  }
}
