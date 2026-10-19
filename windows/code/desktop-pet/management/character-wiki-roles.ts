// WV0-01: the role-registry surface the Wiki import service needs. Implemented over the real
// RoleConfigurationStore by the composition root; tests may provide an isolated equivalent.

export interface CharacterRoleConfigurationStoreLike {
  /** The role must exist before any import touches it. */
  exists(characterId: string): boolean;
  /** Whether this role accepts configuration changes (e.g. not a deleted/archived entry). */
  allowsConfiguration(characterId: string): boolean;
  /** Production pairing resolver: the server never accepts a client-sent userId/instanceId. */
  pairingFor(characterId: string): { userId: string; characterId: string; characterInstanceId: string };
}
