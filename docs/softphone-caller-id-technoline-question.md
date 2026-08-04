# Open question for Technoline support — SIP softphone outbound Caller-ID

## Context

Our browser-based softphone ("טלפון רשת", `frontend/softphone.html`) registers
as a SIP/WebRTC extension directly against Technoline's PBX:

- WebSocket: `wss://sip.ipsales.co.il:8089/ws`
- SIP identity: extension `200`, SIP user `MESER534485`

This is a different integration surface from the documented HTTP APIs
(`campaignApi.php`, `ivrFilesApi.php`), which DO support per-request outbound
Caller-ID selection (`callId` on `campaignRun`, `callerId` on `click2call`).

## What we need

We want a single operator, using this one registered SIP extension, to be
able to select — per outgoing call — which of two approved outbound numbers
is presented to the called party:

- `023766193` ("מספר ראשי")
- `025378787` ("מספר חדש")

## What we checked already

We reviewed every Technoline developer document reachable from
`pbxDocsCenter.html` (the hub page that links every doc): the master
`PBX_DOCUMENTATION_CENTER.md`, `campaignApi.md`, `click2callApiDocs.md`/`.html`,
`ivrExtensionsApiDocs.md`/`.html`, `makeCallApiDocs.html`, `mailingListsApiDocs`,
and the streaming/BYO-AI doc. None of them document a mechanism for
per-call outbound Caller-ID selection on a **SIP-registered device/extension**
(as opposed to the HTTP campaign/click2call APIs). We did not find any
mention of `P-Asserted-Identity`, `Remote-Party-ID`, or a Technoline-specific
SIP header being honored from a registered extension, nor a documented way to
assign more than one outbound DID to a single SIP extension.

## The exact question to send

> Our CRM's browser softphone registers as SIP extension 200 (user
> `MESER534485`) via `wss://sip.ipsales.co.il:8089/ws`. We need this single
> registered extension to present one of two different outbound Caller IDs
> (`023766193` or `025378787`) selectable per outgoing call.
>
> Is this supported, and if so:
>
> (a) via a specific SIP header our client should add to the INVITE (e.g.
> `P-Asserted-Identity`, `Remote-Party-ID`, or a custom `X-` header) that your
> PBX will trust from this extension — if so, please confirm the exact
> header name and format; or
>
> (b) only by provisioning two separate SIP extensions/trunk identities (one
> per Caller ID) that we would register/switch between?
>
> If neither, please advise the supported mechanism, if any, for a single
> softphone extension to present more than one outbound Caller ID.

## Current implementation status

Until this is answered, the softphone UI lets the operator select one of the
two numbers before dialing, and that selection is recorded against the call
in the new call-history log (`softphone_calls.selectedCallerId`) — but **no
SIP header is added to the outgoing INVITE**, and there is no proof this
selection changes what the donor's phone displays. The UI labels this
plainly so nobody mistakes "recorded" for "confirmed effective." Once
Technoline answers, wire the confirmed mechanism into `placeCall()` in
`frontend/softphone.html` (or provision the second extension and switch the
registration, per answer (b)).
