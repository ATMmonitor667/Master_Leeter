export class SignInRequired extends Error {
  constructor() {
    super("Please sign in to continue.");
  }
}
