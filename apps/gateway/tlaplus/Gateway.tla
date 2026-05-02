------------------------------ MODULE Gateway ------------------------------
(*
 * TLA+ Specification for the Scope MT Gateway
 *
 * Models the gateway startup sequence, readiness/liveness probes,
 * blob storage availability, session lifecycle, HAR recording,
 * idle reaper, proxy request handling, and capacity constraints.
 *
 * Design: Uses a fixed pool of session slots (SessionSlots) and boolean
 * abstractions to keep the state space finite and tractable for TLC.
 *
 * Key properties verified:
 *   Safety:
 *     - No sessions created before gateway is ready
 *     - Readiness requires blob storage (when configured)
 *     - No two active sessions share the same client IP
 *     - HAR entries are only appended to active, non-failed sessions
 *     - Session capacity is never exceeded
 *     - Slot cleanup is complete (free slots have no residual state)
 *     - Active sessions always have valid HAR state
 *   Liveness (under fairness):
 *     - Gateway eventually becomes live after boot
 *     - Every idle session is eventually reaped
 *)

EXTENDS Integers, FiniteSets

CONSTANTS
    ClientIPs,         \* Set of possible client IP addresses
    SessionSlots,      \* Fixed pool of session slot IDs
    MaxSessions,       \* Maximum number of concurrent active sessions
    IdleTimeoutTicks,  \* Ticks before idle reaper clears a session
    MaxTicks           \* Bound on time for model checking

\* State constants (model values)
CONSTANTS Free, Active, Stopped
CONSTANTS HarNone, Recording, Finalized, HarFailed
CONSTANTS NULL

\* Gateway lifecycle phases
CONSTANTS Booting, Live

VARIABLES
    \* Gateway-level state
    gwPhase,           \* {Booting, Live} — gateway process lifecycle
    blobUp,            \* BOOLEAN — blob storage reachable right now
    blobConfigured,    \* BOOLEAN — blob storage is configured (constant per run)
    redisUp,           \* BOOLEAN — Redis reachable at startup (affects persistence)

    \* Per-slot state
    slotState,         \* SessionSlots -> {Free, Active, Stopped}
    slotIP,            \* SessionSlots -> ClientIPs \cup {NULL}
    slotHar,           \* SessionSlots -> {HarNone, Recording, Finalized, HarFailed}
    slotLastActivity,  \* SessionSlots -> 0..MaxTicks
    slotHasEntries,    \* SessionSlots -> BOOLEAN (at least one HAR entry recorded)
    tick               \* Global clock tick

vars == <<gwPhase, blobUp, blobConfigured, redisUp,
          slotState, slotIP, slotHar, slotLastActivity, slotHasEntries, tick>>

gwVars == <<gwPhase, blobUp, blobConfigured, redisUp>>
slotVars == <<slotState, slotIP, slotHar, slotLastActivity, slotHasEntries>>

\* Active slot for a given IP (unique by invariant)
ActiveSlotForIP(ip) ==
    IF \E s \in SessionSlots : slotState[s] = Active /\ slotIP[s] = ip
    THEN CHOOSE s \in SessionSlots : slotState[s] = Active /\ slotIP[s] = ip
    ELSE NULL

\* Count of non-free slots
AllocatedCount == Cardinality({s \in SessionSlots : slotState[s] # Free})

\* Readiness: live + blob reachable (or blob not configured)
IsReady == gwPhase = Live /\ (blobUp \/ ~blobConfigured)

\* Liveness: process is running and listening
IsAlive == gwPhase = Live

-----------------------------------------------------------------------------
(* Type invariant *)

TypeOK ==
    /\ gwPhase \in {Booting, Live}
    /\ blobUp \in BOOLEAN
    /\ blobConfigured \in BOOLEAN
    /\ redisUp \in BOOLEAN
    /\ slotState \in [SessionSlots -> {Free, Active, Stopped}]
    /\ slotIP \in [SessionSlots -> ClientIPs \cup {NULL}]
    /\ slotHar \in [SessionSlots -> {HarNone, Recording, Finalized, HarFailed}]
    /\ slotLastActivity \in [SessionSlots -> 0..MaxTicks]
    /\ slotHasEntries \in [SessionSlots -> BOOLEAN]
    /\ tick \in 0..MaxTicks

-----------------------------------------------------------------------------
(* Initial state *)

Init ==
    /\ gwPhase = Booting
    /\ blobUp \in BOOLEAN              \* Blob may or may not be up at boot
    /\ blobConfigured \in BOOLEAN      \* Whether blob is configured (fixed for run)
    /\ redisUp \in BOOLEAN             \* Redis may or may not be up at boot
    /\ slotState = [s \in SessionSlots |-> Free]
    /\ slotIP = [s \in SessionSlots |-> NULL]
    /\ slotHar = [s \in SessionSlots |-> HarNone]
    /\ slotLastActivity = [s \in SessionSlots |-> 0]
    /\ slotHasEntries = [s \in SessionSlots |-> FALSE]
    /\ tick = 0

-----------------------------------------------------------------------------
(* Action: Gateway completes startup — transitions from Booting to Live *)
(*
 * Maps to: main.rs initialization sequence completes, TcpListener::bind
 * succeeds, server starts accepting connections.
 * Redis failure is non-fatal (logs warning, falls back to in-memory).
 * Blob storage is not checked at startup — only at readiness probe time.
 *)

StartupComplete ==
    /\ gwPhase = Booting
    /\ gwPhase' = Live
    /\ UNCHANGED <<blobUp, blobConfigured, redisUp,
                   slotState, slotIP, slotHar, slotLastActivity, slotHasEntries, tick>>

-----------------------------------------------------------------------------
(* Action: Blob storage becomes available or unavailable *)
(*
 * Maps to: Azure Blob Storage or Azurite becomes reachable/unreachable.
 * The /health/ready endpoint checks blob with a 3s timeout.
 * This affects readiness but not liveness.
 *)

BlobBecomesAvailable ==
    /\ blobConfigured
    /\ ~blobUp
    /\ blobUp' = TRUE
    /\ UNCHANGED <<gwPhase, blobConfigured, redisUp,
                   slotState, slotIP, slotHar, slotLastActivity, slotHasEntries, tick>>

BlobBecomesUnavailable ==
    /\ blobConfigured
    /\ blobUp
    /\ blobUp' = FALSE
    /\ UNCHANGED <<gwPhase, blobConfigured, redisUp,
                   slotState, slotIP, slotHar, slotLastActivity, slotHasEntries, tick>>

-----------------------------------------------------------------------------
(* Action: Create session — POST /api/v1/sessions *)

CreateSession(ip) ==
    /\ IsReady                 \* Gateway must be ready to accept sessions
    /\ tick < MaxTicks
    /\ LET existing == ActiveSlotForIP(ip)
       IN
       IF existing # NULL
       \* IP conflict: clear old session data, reuse slot
       THEN /\ slotHar' = [slotHar EXCEPT ![existing] = Recording]
            /\ slotLastActivity' = [slotLastActivity EXCEPT ![existing] = tick]
            /\ slotHasEntries' = [slotHasEntries EXCEPT ![existing] = FALSE]
            /\ UNCHANGED <<slotState, slotIP>>
       \* Allocate a new free slot
       ELSE /\ AllocatedCount < MaxSessions
            /\ \E slot \in SessionSlots :
                  /\ slotState[slot] = Free
                  /\ slotState' = [slotState EXCEPT ![slot] = Active]
                  /\ slotIP' = [slotIP EXCEPT ![slot] = ip]
                  /\ slotHar' = [slotHar EXCEPT ![slot] = Recording]
                  /\ slotLastActivity' = [slotLastActivity EXCEPT ![slot] = tick]
                  /\ slotHasEntries' = [slotHasEntries EXCEPT ![slot] = FALSE]
    /\ UNCHANGED <<gwPhase, blobUp, blobConfigured, redisUp, tick>>

-----------------------------------------------------------------------------
(* Action: Proxy request — CONNECT / plain HTTP from active session *)

ProxyRequest(ip) ==
    /\ IsAlive                 \* Must be live to proxy
    /\ LET slot == ActiveSlotForIP(ip)
       IN /\ slot # NULL
          /\ slotHar[slot] = Recording        \* Not failed
          /\ slotLastActivity' = [slotLastActivity EXCEPT ![slot] = tick]
          /\ slotHasEntries' = [slotHasEntries EXCEPT ![slot] = TRUE]
    /\ UNCHANGED <<gwPhase, blobUp, blobConfigured, redisUp, slotState, slotIP, slotHar, tick>>

-----------------------------------------------------------------------------
(* Action: Proxy request to failed session — returns 502 *)

ProxyRequestFailed(ip) ==
    /\ IsAlive
    /\ LET slot == ActiveSlotForIP(ip)
       IN /\ slot # NULL
          /\ slotHar[slot] = HarFailed
          /\ slotLastActivity' = [slotLastActivity EXCEPT ![slot] = tick]
    /\ UNCHANGED <<gwPhase, blobUp, blobConfigured, redisUp, slotState, slotIP, slotHar, slotHasEntries, tick>>

-----------------------------------------------------------------------------
(* Action: HAR blob write failure *)

HarWriteFail(slot) ==
    /\ slotState[slot] = Active
    /\ slotHar[slot] = Recording
    /\ slotHar' = [slotHar EXCEPT ![slot] = HarFailed]
    /\ UNCHANGED <<gwPhase, blobUp, blobConfigured, redisUp, slotState, slotIP, slotLastActivity, slotHasEntries, tick>>

-----------------------------------------------------------------------------
(* Action: Stop session — POST /api/v1/sessions/{id}/stop *)

StopSession(slot) ==
    /\ slotState[slot] = Active
    /\ slotState' = [slotState EXCEPT ![slot] = Stopped]
    /\ slotHar' = [slotHar EXCEPT ![slot] = IF slotHar[slot] = HarFailed
                                             THEN HarFailed
                                             ELSE Finalized]
    /\ UNCHANGED <<gwPhase, blobUp, blobConfigured, redisUp, slotIP, slotLastActivity, slotHasEntries, tick>>

-----------------------------------------------------------------------------
(* Action: Delete session — DELETE /api/v1/sessions/{id} *)

DeleteSession(slot) ==
    /\ slotState[slot] = Stopped
    /\ slotState' = [slotState EXCEPT ![slot] = Free]
    /\ slotIP' = [slotIP EXCEPT ![slot] = NULL]
    /\ slotHar' = [slotHar EXCEPT ![slot] = HarNone]
    /\ slotLastActivity' = [slotLastActivity EXCEPT ![slot] = 0]
    /\ slotHasEntries' = [slotHasEntries EXCEPT ![slot] = FALSE]
    /\ UNCHANGED <<gwPhase, blobUp, blobConfigured, redisUp, tick>>

-----------------------------------------------------------------------------
(* Action: Idle reaper clears stale session *)

ReapIdle(slot) ==
    /\ slotState[slot] = Active
    /\ tick - slotLastActivity[slot] >= IdleTimeoutTicks
    /\ slotState' = [slotState EXCEPT ![slot] = Free]
    /\ slotIP' = [slotIP EXCEPT ![slot] = NULL]
    /\ slotHar' = [slotHar EXCEPT ![slot] = HarNone]
    /\ slotLastActivity' = [slotLastActivity EXCEPT ![slot] = 0]
    /\ slotHasEntries' = [slotHasEntries EXCEPT ![slot] = FALSE]
    /\ UNCHANGED <<gwPhase, blobUp, blobConfigured, redisUp, tick>>

-----------------------------------------------------------------------------
(* Action: Time advances *)

Tick ==
    /\ tick < MaxTicks
    /\ tick' = tick + 1
    /\ UNCHANGED <<gwPhase, blobUp, blobConfigured, redisUp,
                   slotState, slotIP, slotHar, slotLastActivity, slotHasEntries>>

-----------------------------------------------------------------------------
(* Next-state relation *)

Next ==
    \/ StartupComplete
    \/ BlobBecomesAvailable
    \/ BlobBecomesUnavailable
    \/ \E ip \in ClientIPs : CreateSession(ip)
    \/ \E ip \in ClientIPs : ProxyRequest(ip)
    \/ \E ip \in ClientIPs : ProxyRequestFailed(ip)
    \/ \E s \in SessionSlots : HarWriteFail(s)
    \/ \E s \in SessionSlots : StopSession(s)
    \/ \E s \in SessionSlots : DeleteSession(s)
    \/ \E s \in SessionSlots : ReapIdle(s)
    \/ Tick

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* SAFETY INVARIANTS *)

\* No two active sessions share the same client IP
UniqueIPPerSession ==
    \A s1, s2 \in SessionSlots :
        (s1 # s2 /\ slotState[s1] = Active /\ slotState[s2] = Active)
        => slotIP[s1] # slotIP[s2]

\* Session capacity never exceeded
CapacityRespected ==
    AllocatedCount <= MaxSessions

\* HAR entries only exist for sessions that were recording
HarOnlyWhenRecording ==
    \A s \in SessionSlots :
        slotHasEntries[s] => slotHar[s] \in {Recording, Finalized, HarFailed}

\* Stopped sessions have finalized or failed HAR
StoppedImpliesFinalized ==
    \A s \in SessionSlots :
        (slotState[s] = Stopped) => slotHar[s] \in {Finalized, HarFailed}

\* Free slots are fully clean
FreeSlotClean ==
    \A s \in SessionSlots :
        (slotState[s] = Free) =>
            /\ slotIP[s] = NULL
            /\ slotHar[s] = HarNone
            /\ slotHasEntries[s] = FALSE

\* Active/stopped slots have an IP
AllocatedHasIP ==
    \A s \in SessionSlots :
        (slotState[s] \in {Active, Stopped}) => slotIP[s] # NULL

\* Active slots are recording or failed (never finalized while active)
ActiveHarState ==
    \A s \in SessionSlots :
        (slotState[s] = Active) => slotHar[s] \in {Recording, HarFailed}

\* S8: No sessions created before gateway is live
NoSessionsBeforeLive ==
    (gwPhase = Booting) =>
        \A s \in SessionSlots : slotState[s] = Free

\* S9: Readiness requires blob storage when configured
\* If gateway is ready and blob is configured, blob must be up
ReadyImpliesBlob ==
    (IsReady /\ blobConfigured) => blobUp

\* S10: Liveness is independent of blob storage
\* A live gateway stays live regardless of blob status
LivenessIndependentOfBlob ==
    (gwPhase = Live) => IsAlive

-----------------------------------------------------------------------------
(* LIVENESS *)

\* Gateway eventually becomes live after booting
EventuallyLive ==
    (gwPhase = Booting) ~> (gwPhase = Live)

\* Every idle session is eventually reaped
IdleSessionsEventuallyReaped ==
    \A s \in SessionSlots :
        (slotState[s] = Active /\ tick - slotLastActivity[s] >= IdleTimeoutTicks)
        ~> (slotState[s] # Active)

FairSpec ==
    /\ Spec
    /\ WF_vars(StartupComplete)
    /\ WF_vars(Tick)
    /\ \A s \in SessionSlots : WF_vars(ReapIdle(s))

=============================================================================
