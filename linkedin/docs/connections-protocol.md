# Connection invitations

LinkedIn Android 4.1.1261, APK SHA-256 `60e4a43691c6440c641707edd3e3201e0dd46eeba9e0363fe99945c84fe4ba4c`, builds a separate native action for connection invitations. It is not a fallback message transport. The CLI requires an explicit invitation plan and send confirmation.

```text
POST /voyager/api/voyagerRelationshipsDashMemberRelationships
  ?action=verifyQuotaAndCreateV2
  &decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-1
{
  invitee: {inviteeUnion: {memberProfile: RESOLVED_FSD_PROFILE_URN}},
  customMessage: EXACT_NOTE
}
```

`InvitationActionManagerImpl.sendInvite(NormInvitation, ...)` converts the recipient to a Dash profile URN, constructs `InviteeUnion.memberProfile`, and writes `invitee`, `customMessage`, optional `midToken` and optional `customInvitePrefillTemplateType`. For the plain profile invitation here, the optional fields are absent. `InvitationActionsRepository$verifyQuotaAndSendInvite$2.getDataManagerRequest` selects the V2 action and decoration. `InvitationCreationResult` defines `invitationUrn`, `invitation`, and optional invitee/following fields.

REA identified the request class (`ev_659156e7a976a7f281d6176814cffa874aa186ce0c014aa3417f0b614a3514f1`), but its decompiler body was unavailable and a focused body lookup failed. Complete direct DEX/smali inspection supplied the fallback evidence. Private decoded-file SHA-256 digests:

| Class | Decoded evidence SHA-256 |
| --- | --- |
| `InvitationActionManagerImpl` | `0b884aaf0ded642c3e55accdffbbd9cb08e3bc68ed607752568dd90849f8fadb` |
| `InvitationActionsRepository$verifyQuotaAndSendInvite$2` | `bfe8d12ea32b75050458c542db48bb78c1640431ee6cd20c72382b9791485cd4` |
| `InvitationCreationResult` | `8076b8adccae3ef05aeab661203037693d812ee882a1e2c0a26d660938b6967b` |

The authorized live test ran through the CLI on the Linux ARM64 Orin with no display and the emulator stopped. LinkedIn returned HTTP 200 with `value.invitationUrn` and `value.invitation.entityUrn` matching. The returned invitation decoration omitted `invitationState`, so the CLI reports acceptance and a null state rather than inventing a pending/accepted relationship state.

A separate read of the original Pixel app's recipient profile subsequently exposed the native accessibility label `Pending, click to withdraw invitation sent to …`, confirming the pending invitation. No send or withdrawal was performed in the Android UI. The persisted CLI status remains the original server confirmation; it is not a live relationship lookup.

The process lock and private journal bind the plan to its sender, recipient and note and record `sending` before the request. A timeout, unexpected success response, or interrupted response remains unknown. An attempted operation cannot be sent again. No server idempotency guarantee or automatic reconciliation is claimed. The CLI does not buy Premium, start trials, accept incoming invitations, or withdraw invitations.
