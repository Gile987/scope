------------------------------ MODULE Gateway ------------------------------
(*
 * TLA+ Specification for the Scope MT Gateway
 *
 * Models the core session lifecycle, HAR recording, idle reaper, proxy
 * request handling, IP-to-session mapping, and capacity constraints.
 *
 * Design: Uses a fixed pool of session slots (SessionSlots) and boolean
 * abstractions to keep the state space finite and tractable for TLC.
 *
 * Key properties verified:
 *   Safety:
 *     - No two active sessions share the same client IP
 *     - HAR entries are only appended to active, non-failed sessions
 *     - Session capacity is never exceeded
 *     - Slot cleanup is complete (free slots have no residual state)
 *     - Active sessions always have valid HAR state
 *   Liveness (under fairness):
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

VARIABLES
    slotState,         \* SessionSlots -> {Free, Active, Stopped}
    slotIP,            \* SessionSlots -> ClientIPs \cup {NULL}
    slotHar,           \* SessionSlots -> {HarNone, Recording, Finalized, HarFailed}
    slotLastActivity,  \* SessionSlots -> 0..MaxTicks
    slotHasEntries,    \* SessionSlots -> BOOLEAN (at least one HAR entry recorded)
    tick               \* Global clock tick

vars == <<slotState, slotIP, slotHar, slotLastActivity, slotHasEntries, tick>>

\* Active slot for a given IP (unique by invariant)
ActiveSlotForIP(ip) ==
    IF \E s \in SessionSlots : slotState[s] = Active /\ slotIP[s] = ip
    THEN CHOOSE s \in SessionSlots : slotState[s] = Active /\ slotIP[s] = ip
    ELSE NULL

\* Count of non-free slots
AllocatedCount == Cardinality({s \in SessionSlots : slotState[s] # Free})

-----------------------------------------------------------------------------
(* Type invariant *)

TypeOK ==
    /\ slotState \in [SessionSlots -> {Free, Active, Stopped}]
    /\ slotIP \in [SessionSlots -> ClientIPs \cup {NULL}]
    /\ slotHar \in [SessionSlots -> {HarNone, Recording, Finalized, HarFailed}]
    /\ slotLastActivity \in [SessionSlots -> 0..MaxTicks]
    /\ slotHasEntries \in [SessionSlots -> BOOLEAN]
    /\ tick \in 0..MaxTicks

-----------------------------------------------------------------------------
(* Initial state *)

Init ==
    /\ slotState = [s \in SessionSlots |-> Free]
    /\ slotIP = [s \in SessionSlots |-> NULL]
    /\ slotHar = [s \in SessionSlots |-> HarNone]
    /\ slotLastActivity = [s \in SessionSlots |-> 0]
    /\ slotHasEntries = [s \in SessionSlots |-> FALSE]
    /\ tick = 0

-----------------------------------------------------------------------------
(* Action: Create session — POST /api/v1/sessions *)

CreateSession(ip) ==
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
    /\ UNCHANGED tick

-----------------------------------------------------------------------------
(* Action: Proxy request — CONNECT / plain HTTP from active session *)

ProxyRequest(ip) ==
    /\ LET slot == ActiveSlotForIP(ip)
       IN /\ slot # NULL
          /\ slotHar[slot] = Recording        \* Not failed
          /\ slotLastActivity' = [slotLastActivity EXCEPT ![slot] = tick]
          /\ slotHasEntries' = [slotHasEntries EXCEPT ![slot] = TRUE]
    /\ UNCHANGED <<slotState, slotIP, slotHar, tick>>

-----------------------------------------------------------------------------
(* Action: Proxy request to failed session — returns 502 *)

ProxyRequestFailed(ip) ==
    /\ LET slot == ActiveSlotForIP(ip)
       IN /\ slot # NULL
          /\ slotHar[slot] = HarFailed
          /\ slotLastActivity' = [slotLastActivity EXCEPT ![slot] = tick]
    /\ UNCHANGED <<slotState, slotIP, slotHar, slotHasEntries, tick>>

-----------------------------------------------------------------------------
(* Action: HAR blob write failure *)

HarWriteFail(slot) ==
    /\ slotState[slot] = Active
    /\ slotHar[slot] = Recording
    /\ slotHar' = [slotHar EXCEPT ![slot] = HarFailed]
    /\ UNCHANGED <<slotState, slotIP, slotLastActivity, slotHasEntries, tick>>

-----------------------------------------------------------------------------
(* Action: Stop session — POST /api/v1/sessions/{id}/stop *)

StopSession(slot) ==
    /\ slotState[slot] = Active
    /\ slotState' = [slotState EXCEPT ![slot] = Stopped]
    /\ slotHar' = [slotHar EXCEPT ![slot] = IF slotHar[slot] = HarFailed
                                             THEN HarFailed
                                             ELSE Finalized]
    /\ UNCHANGED <<slotIP, slotLastActivity, slotHasEntries, tick>>

-----------------------------------------------------------------------------
(* Action: Delete session — DELETE /api/v1/sessions/{id} *)

DeleteSession(slot) ==
    /\ slotState[slot] = Stopped
    /\ slotState' = [slotState EXCEPT ![slot] = Free]
    /\ slotIP' = [slotIP EXCEPT ![slot] = NULL]
    /\ slotHar' = [slotHar EXCEPT ![slot] = HarNone]
    /\ slotLastActivity' = [slotLastActivity EXCEPT ![slot] = 0]
    /\ slotHasEntries' = [slotHasEntries EXCEPT ![slot] = FALSE]
    /\ UNCHANGED tick

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
    /\ UNCHANGED tick

-----------------------------------------------------------------------------
(* Action: Time advances *)

Tick ==
    /\ tick < MaxTicks
    /\ tick' = tick + 1
    /\ UNCHANGED <<slotState, slotIP, slotHar, slotLastActivity, slotHasEntries>>

-----------------------------------------------------------------------------
(* Next-state relation *)

Next ==
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

-----------------------------------------------------------------------------
(* LIVENESS *)

\* Every idle session is eventually reaped
IdleSessionsEventuallyReaped ==
    \A s \in SessionSlots :
        (slotState[s] = Active /\ tick - slotLastActivity[s] >= IdleTimeoutTicks)
        ~> (slotState[s] # Active)

FairSpec ==
    /\ Spec
    /\ WF_vars(Tick)
    /\ \A s \in SessionSlots : WF_vars(ReapIdle(s))

=============================================================================
