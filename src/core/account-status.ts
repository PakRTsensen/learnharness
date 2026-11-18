/** Public, controller-derived account presentation. No local or Clerk identity
 * is exported to the browser; role and administrator authority come only from
 * the controller registry. */
export interface PublicAccountStatus {
	readonly role: "member" | "admin";
	readonly lifecycle: "active" | "disabled" | "pending-deletion";
	/** Non-content recovery deadline, when the controller supplies one. */
	readonly recoveringUntil: string | null;
}
