/** An `on:` block that GitHub itself would refuse, such as `branches` beside `branches-ignore`. */
export class TriggerError extends Error {
  override readonly name = 'TriggerError';
}
