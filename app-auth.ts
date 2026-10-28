// Who is buying, for `POST /paddle/app-checkout`: the route an app with a PurchaseController
// calls to start a Paddle checkout. Replace `authenticateAppUser` with your app's own
// authentication (a session cookie, a JWT you issue, Sign in with Apple, ...).
//
// It must return the id your app passes to `Superwall.shared.identify(userId:)`, read from a
// credential your server checks. Never take the user id from the request body: anyone could
// then buy access for another user, or attach their payment to someone else's account.
import type { IncomingMessage } from "node:http"

export class AppAuthNotConfigured extends Error {
  override readonly name = "AppAuthNotConfigured"
}

/**
 * The authenticated app user's id, or `undefined` when the request carries no valid
 * credential (the route answers 401). Until you implement it, the route answers 501.
 */
export type AuthenticateAppUser = (request: IncomingMessage) => Promise<string | undefined>

export const authenticateAppUser: AuthenticateAppUser = async () => {
  throw new AppAuthNotConfigured(
    "POST /paddle/app-checkout is off: implement authenticateAppUser in app-auth.ts"
  )
}
