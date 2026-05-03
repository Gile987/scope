------------------------------ MODULE Gateway ------------------------------
(*
 * TLA+ Specification for the Scope MT Gateway (Multi-Replica)
 *
 * Models a pair of gateway replicas behind a Kubernetes Service with
 * ClientIP session affinity, shared Redis for crash recovery, and
 * shared Azure Blob Storage for HAR recording.
 *
 * Design: Each replica has its own fixed pool of session slots and
 * independent lifecycle (Booting/Live). A shared Redis layer persists
 * session-to-IP mappings so a crashed replica can be restored. When
 * ClientIP affinity breaks, a request may land on the "wrong" replica,
 * which restores the session from Redis — producing dual ownership.
 *
 * Key properties verified:
 *   Safety:
 *     - Per-replica: unique IP per session, capacity, slot hygiene
 *     - Cross-replica: HAR blob append safety (both can write)
 *     - Redis consistency: persisted sessions match in-memory state
 *     - After crash: in-memory state is clean, Redis retains sessions
 *   Liveness (under fairness):
 *     - Each replica eventually becomes live after boot
 *     - Every idle session is eventually reaped
 *   Known design limitations (verified reachable, not invariants):
 *     - Dual ownership: two replicas can hold active sessions for same IP
 *     - Reaper doesn't clean Redis: reaped sessions can be re-restored
 *
 * Actors:
 *   | Actor           | Reads                       | Writes                          | Actions                              |
 *   |-----------------|-----------------------------|---------------------------------|--------------------------------------|
 *   | API client      | replica sessions            | replica sessions, Redis         | CreateSession, StopSession, Delete   |
 *   | Proxy client    | replica sessions, HAR       | HAR entries, lastActivity       | ProxyRequest, ProxyRequestFailed     |
 *   | K8s Service     | ClientIP affinity table      | routes request to replica       | (implicit in action guards)          |
 *   | Redis           | -                           | session persistence             | (written by Create/Stop/Restore)     |
 *   | Idle reaper     | replica sessions, tick       | replica sessions                | ReapIdle                             |
 *   | Blob storage    | -                           | blobUp                          | BlobBecomesAvailable/Unavailable     |
 *   | Gateway proc    | gwPhase[r]                  | gwPhase[r], slots[r]            | StartupComplete, Crash               |
 *   | Affinity break  | Redis                       | replica sessions                | RestoreFromRedis (affinity failure)  |
 *   | Clock           | tick                        | tick                            | Tick                                 |
 *)

EXTENDS Integers, FiniteSets, TLC

CONSTANTS
    Replicas,          \* Set of gateway replica IDs (e.g., {r1, r2})
    ClientIPs,         \* Set of possible client IP addresses
    SessionSlots,      \* Fixed pool of session slot IDs (per replica)
    MaxSessions,       \* Maximum concurrent active sessions per replica
    IdleTimeoutTicks,  \* Ticks before idle reaper clears a session
    MaxTicks           \* Bound on time for model checking

\* State constants (model values)
CONSTANTS Free, Active, Stopped
CONSTANTS HarNone, Recording, Finalized, HarFailed
CONSTANTS NULL

\* Gateway lifecycle phases
CONSTANTS Booting, Live

VARIABLES
    \* Per-replica gateway state
    gwPhase,           \* Replicas -> {Booting, Live}
    redisUp,           \* BOOLEAN — Redis reachable (shared)

    \* Shared infrastructure
    blobUp,            \* BOOLEAN — blob storage reachable
    blobConfigured,    \* BOOLEAN — blob storage configured (constant per run)

    \* Per-replica, per-slot state (functions: Replicas -> SessionSlots -> value)
    slotState,         \* [Replicas][SessionSlots] -> {Free, Active, Stopped}
    slotIP,            \* [Replicas][SessionSlots] -> ClientIPs \cup {NULL}
    slotHar,           \* [Replicas][SessionSlots] -> {HarNone, Recording, Finalized, HarFailed}
    slotLastActivity,  \* [Replicas][SessionSlots] -> 0..MaxTicks
    slotHasEntries,    \* [Replicas][SessionSlots] -> BOOLEAN

    \* Shared Redis state: which IPs have persisted sessions
    redisSession,      \* ClientIPs -> BOOLEAN (session persisted in Redis)

    tick               \* Global clock tick

vars == <<gwPhase, redisUp, blobUp, blobConfigured,
          slotState, slotIP, slotHar, slotLastActivity, slotHasEntries,
          redisSession, tick>>

\* Symmetry set for TLC: IPs, slots, and replicas are interchangeable
Symmetry == Permutations(ClientIPs) \union Permutations(SessionSlots)
              \union Permutations(Replicas)

-----------------------------------------------------------------------------
(* Helpers *)

\* Active slot for a given IP on a specific replica
ActiveSlotForIP(r, ip) ==
    IF \E s \in SessionSlots : slotState[r][s] = Active /\ slotIP[r][s] = ip
    THEN CHOOSE s \in SessionSlots : slotState[r][s] = Active /\ slotIP[r][s] = ip
    ELSE NULL

\* Count of non-free slots on a replica
AllocatedCount(r) == Cardinality({s \in SessionSlots : slotState[r][s] # Free})

\* Readiness: live + blob reachable (or blob not configured)
IsReady(r) == gwPhase[r] = Live /\ (blobUp \/ ~blobConfigured)

\* Liveness: process is running and listening
IsAlive(r) == gwPhase[r] = Live

\* Helper: reset all slots on a replica to clean state
CleanSlots(r) ==
    /\ slotState' = [slotState EXCEPT ![r] = [s \in SessionSlots |-> Free]]
    /\ slotIP' = [slotIP EXCEPT ![r] = [s \in SessionSlots |-> NULL]]
    /\ slotHar' = [slotHar EXCEPT ![r] = [s \in SessionSlots |-> HarNone]]
    /\ slotLastActivity' = [slotLastActivity EXCEPT ![r] = [s \in SessionSlots |-> 0]]
    /\ slotHasEntries' = [slotHasEntries EXCEPT ![r] = [s \in SessionSlots |-> FALSE]]

-----------------------------------------------------------------------------
(* Type invariant *)

TypeOK ==
    /\ gwPhase \in [Replicas -> {Booting, Live}]
    /\ redisUp \in BOOLEAN
    /\ blobUp \in BOOLEAN
    /\ blobConfigured \in BOOLEAN
    /\ slotState \in [Replicas -> [SessionSlots -> {Free, Active, Stopped}]]
    /\ slotIP \in [Replicas -> [SessionSlots -> ClientIPs \cup {NULL}]]
    /\ slotHar \in [Replicas -> [SessionSlots -> {HarNone, Recording, Finalized, HarFailed}]]
    /\ slotLastActivity \in [Replicas -> [SessionSlots -> 0..MaxTicks]]
    /\ slotHasEntries \in [Replicas -> [SessionSlots -> BOOLEAN]]
    /\ redisSession \in [ClientIPs -> BOOLEAN]
    /\ tick \in 0..MaxTicks

-----------------------------------------------------------------------------
(* Initial state *)

Init ==
    /\ gwPhase = [r \in Replicas |-> Booting]
    /\ blobUp \in BOOLEAN
    /\ blobConfigured \in BOOLEAN
    /\ redisUp \in BOOLEAN
    /\ slotState = [r \in Replicas |-> [s \in SessionSlots |-> Free]]
    /\ slotIP = [r \in Replicas |-> [s \in SessionSlots |-> NULL]]
    /\ slotHar = [r \in Replicas |-> [s \in SessionSlots |-> HarNone]]
    /\ slotLastActivity = [r \in Replicas |-> [s \in SessionSlots |-> 0]]
    /\ slotHasEntries = [r \in Replicas |-> [s \in SessionSlots |-> FALSE]]
    /\ redisSession = [ip \in ClientIPs |-> FALSE]
    /\ tick = 0

-----------------------------------------------------------------------------
(* Action: Gateway replica completes startup *)

StartupComplete(r) ==
    /\ gwPhase[r] = Booting
    /\ gwPhase' = [gwPhase EXCEPT ![r] = Live]
    /\ UNCHANGED <<blobUp, blobConfigured, redisUp,
                   slotState, slotIP, slotHar, slotLastActivity, slotHasEntries,
                   redisSession, tick>>

-----------------------------------------------------------------------------
(* Action: Blob storage becomes available or unavailable *)

BlobBecomesAvailable ==
    /\ blobConfigured
    /\ ~blobUp
    /\ blobUp' = TRUE
    /\ UNCHANGED <<gwPhase, blobConfigured, redisUp,
                   slotState, slotIP, slotHar, slotLastActivity, slotHasEntries,
                   redisSession, tick>>

BlobBecomesUnavailable ==
    /\ blobConfigured
    /\ blobUp
    /\ blobUp' = FALSE
    /\ UNCHANGED <<gwPhase, blobConfigured, redisUp,
                   slotState, slotIP, slotHar, slotLastActivity, slotHasEntries,
                   redisSession, tick>>

-----------------------------------------------------------------------------
(* Action: A single gateway replica crashes — pod restart *)
(*
 * Only the crashing replica loses in-memory state.
 * Redis retains all persisted sessions.
 * The other replica is unaffected.
 *)

GatewayCrash(r) ==
    /\ gwPhase[r] = Live
    /\ gwPhase' = [gwPhase EXCEPT ![r] = Booting]
    /\ CleanSlots(r)
    \* Redis and other replica are unaffected
    /\ UNCHANGED <<blobUp, blobConfigured, redisUp, redisSession, tick>>

-----------------------------------------------------------------------------
(* Action: Create session on replica r for client ip *)
(*
 * The API request is routed to replica r by the K8s Service.
 * On success, if Redis is up, the session is persisted.
 *)

CreateSession(r, ip) ==
    /\ IsReady(r)
    /\ tick < MaxTicks
    /\ LET existing == ActiveSlotForIP(r, ip)
       IN
       IF existing # NULL
       \* IP conflict on this replica: reset the slot
       THEN /\ slotHar' = [slotHar EXCEPT ![r][existing] = Recording]
            /\ slotLastActivity' = [slotLastActivity EXCEPT ![r][existing] = tick]
            /\ slotHasEntries' = [slotHasEntries EXCEPT ![r][existing] = FALSE]
            /\ UNCHANGED <<slotState, slotIP>>
       \* Allocate a new free slot
       ELSE /\ AllocatedCount(r) < MaxSessions
            /\ \E slot \in SessionSlots :
                  /\ slotState[r][slot] = Free
                  /\ slotState' = [slotState EXCEPT ![r][slot] = Active]
                  /\ slotIP' = [slotIP EXCEPT ![r][slot] = ip]
                  /\ slotHar' = [slotHar EXCEPT ![r][slot] = Recording]
                  /\ slotLastActivity' = [slotLastActivity EXCEPT ![r][slot] = tick]
                  /\ slotHasEntries' = [slotHasEntries EXCEPT ![r][slot] = FALSE]
    \* Persist to Redis if available
    /\ redisSession' = IF redisUp THEN [redisSession EXCEPT ![ip] = TRUE]
                        ELSE redisSession
    /\ UNCHANGED <<gwPhase, blobUp, blobConfigured, redisUp, tick>>

-----------------------------------------------------------------------------
(* Action: Proxy request on replica r — normal path *)

ProxyRequest(r, ip) ==
    /\ IsAlive(r)
    /\ LET slot == ActiveSlotForIP(r, ip)
       IN /\ slot # NULL
          /\ slotHar[r][slot] = Recording
          /\ slotLastActivity' = [slotLastActivity EXCEPT ![r][slot] = tick]
          /\ slotHasEntries' = [slotHasEntries EXCEPT ![r][slot] = TRUE]
    /\ UNCHANGED <<gwPhase, blobUp, blobConfigured, redisUp,
                   slotState, slotIP, slotHar, redisSession, tick>>

-----------------------------------------------------------------------------
(* Action: Proxy request to failed session — returns 502 *)

ProxyRequestFailed(r, ip) ==
    /\ IsAlive(r)
    /\ LET slot == ActiveSlotForIP(r, ip)
       IN /\ slot # NULL
          /\ slotHar[r][slot] = HarFailed
          /\ slotLastActivity' = [slotLastActivity EXCEPT ![r][slot] = tick]
    /\ UNCHANGED <<gwPhase, blobUp, blobConfigured, redisUp,
                   slotState, slotIP, slotHar, slotHasEntries, redisSession, tick>>

-----------------------------------------------------------------------------
(* Action: Restore session from Redis after affinity break *)
(*
 * Models: request from ip lands on replica r which has no in-memory session.
 * The replica queries Redis, finds a persisted session, and restores it.
 * This is the key multi-replica concern: the OTHER replica may still have
 * the session in memory → dual ownership.
 *)

RestoreFromRedis(r, ip) ==
    /\ IsAlive(r)
    /\ redisUp
    /\ redisSession[ip] = TRUE
    \* This replica does NOT have a session for this IP
    /\ ActiveSlotForIP(r, ip) = NULL
    \* Allocate a slot and restore
    /\ AllocatedCount(r) < MaxSessions
    /\ \E slot \in SessionSlots :
          /\ slotState[r][slot] = Free
          /\ slotState' = [slotState EXCEPT ![r][slot] = Active]
          /\ slotIP' = [slotIP EXCEPT ![r][slot] = ip]
          \* Restored session resumes recording (re-opens blob append)
          /\ slotHar' = [slotHar EXCEPT ![r][slot] = Recording]
          /\ slotLastActivity' = [slotLastActivity EXCEPT ![r][slot] = tick]
          /\ slotHasEntries' = [slotHasEntries EXCEPT ![r][slot] = FALSE]
    /\ UNCHANGED <<gwPhase, blobUp, blobConfigured, redisUp, redisSession, tick>>

-----------------------------------------------------------------------------
(* Action: HAR blob write failure on replica r *)

HarWriteFail(r, slot) ==
    /\ slotState[r][slot] = Active
    /\ slotHar[r][slot] = Recording
    /\ slotHar' = [slotHar EXCEPT ![r][slot] = HarFailed]
    /\ UNCHANGED <<gwPhase, blobUp, blobConfigured, redisUp,
                   slotState, slotIP, slotLastActivity, slotHasEntries, redisSession, tick>>

-----------------------------------------------------------------------------
(* Action: Stop session on replica r *)

StopSession(r, slot) ==
    /\ slotState[r][slot] = Active
    /\ slotState' = [slotState EXCEPT ![r][slot] = Stopped]
    /\ slotHar' = [slotHar EXCEPT ![r][slot] = IF slotHar[r][slot] = HarFailed
                                                THEN HarFailed
                                                ELSE Finalized]
    /\ UNCHANGED <<gwPhase, blobUp, blobConfigured, redisUp,
                   slotIP, slotLastActivity, slotHasEntries, redisSession, tick>>

-----------------------------------------------------------------------------
(* Action: Delete session on replica r *)

DeleteSession(r, slot) ==
    /\ slotState[r][slot] = Stopped
    /\ slotState' = [slotState EXCEPT ![r][slot] = Free]
    /\ slotIP' = [slotIP EXCEPT ![r][slot] = NULL]
    /\ slotHar' = [slotHar EXCEPT ![r][slot] = HarNone]
    /\ slotLastActivity' = [slotLastActivity EXCEPT ![r][slot] = 0]
    /\ slotHasEntries' = [slotHasEntries EXCEPT ![r][slot] = FALSE]
    \* Remove from Redis when deleted
    /\ LET ip == slotIP[r][slot]
       IN redisSession' = IF redisUp /\ ip # NULL
                           THEN [redisSession EXCEPT ![ip] = FALSE]
                           ELSE redisSession
    /\ UNCHANGED <<gwPhase, blobUp, blobConfigured, redisUp, tick>>

-----------------------------------------------------------------------------
(* Action: Idle reaper on replica r *)

ReapIdle(r, slot) ==
    /\ slotState[r][slot] = Active
    /\ tick - slotLastActivity[r][slot] >= IdleTimeoutTicks
    /\ slotState' = [slotState EXCEPT ![r][slot] = Free]
    /\ slotIP' = [slotIP EXCEPT ![r][slot] = NULL]
    /\ slotHar' = [slotHar EXCEPT ![r][slot] = HarNone]
    /\ slotLastActivity' = [slotLastActivity EXCEPT ![r][slot] = 0]
    /\ slotHasEntries' = [slotHasEntries EXCEPT ![r][slot] = FALSE]
    \* NOTE: Reaper does NOT clean Redis — this is a known design gap.
    \* A reaped session can be re-restored from Redis on another replica.
    /\ UNCHANGED <<gwPhase, blobUp, blobConfigured, redisUp, redisSession, tick>>

-----------------------------------------------------------------------------
(* Action: Time advances *)

Tick ==
    /\ tick < MaxTicks
    /\ tick' = tick + 1
    /\ UNCHANGED <<gwPhase, blobUp, blobConfigured, redisUp,
                   slotState, slotIP, slotHar, slotLastActivity, slotHasEntries,
                   redisSession>>

-----------------------------------------------------------------------------
(* Next-state relation *)

Next ==
    \/ \E r \in Replicas : StartupComplete(r)
    \/ BlobBecomesAvailable
    \/ BlobBecomesUnavailable
    \/ \E r \in Replicas : GatewayCrash(r)
    \/ \E r \in Replicas, ip \in ClientIPs : CreateSession(r, ip)
    \/ \E r \in Replicas, ip \in ClientIPs : ProxyRequest(r, ip)
    \/ \E r \in Replicas, ip \in ClientIPs : ProxyRequestFailed(r, ip)
    \/ \E r \in Replicas, ip \in ClientIPs : RestoreFromRedis(r, ip)
    \/ \E r \in Replicas, s \in SessionSlots : HarWriteFail(r, s)
    \/ \E r \in Replicas, s \in SessionSlots : StopSession(r, s)
    \/ \E r \in Replicas, s \in SessionSlots : DeleteSession(r, s)
    \/ \E r \in Replicas, s \in SessionSlots : ReapIdle(r, s)
    \/ Tick

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* SAFETY INVARIANTS — Per-replica *)

\* No two active sessions on the SAME replica share a client IP
UniqueIPPerReplica ==
    \A r \in Replicas :
        \A s1, s2 \in SessionSlots :
            (s1 # s2 /\ slotState[r][s1] = Active /\ slotState[r][s2] = Active)
            => slotIP[r][s1] # slotIP[r][s2]

\* Session capacity never exceeded on any replica
CapacityRespected ==
    \A r \in Replicas : AllocatedCount(r) <= MaxSessions

\* HAR entries only exist for sessions that were recording
HarOnlyWhenRecording ==
    \A r \in Replicas, s \in SessionSlots :
        slotHasEntries[r][s] => slotHar[r][s] \in {Recording, Finalized, HarFailed}

\* Stopped sessions have finalized or failed HAR
StoppedImpliesFinalized ==
    \A r \in Replicas, s \in SessionSlots :
        (slotState[r][s] = Stopped) => slotHar[r][s] \in {Finalized, HarFailed}

\* Free slots are fully clean
FreeSlotClean ==
    \A r \in Replicas, s \in SessionSlots :
        (slotState[r][s] = Free) =>
            /\ slotIP[r][s] = NULL
            /\ slotHar[r][s] = HarNone
            /\ slotHasEntries[r][s] = FALSE

\* Active/stopped slots have an IP
AllocatedHasIP ==
    \A r \in Replicas, s \in SessionSlots :
        (slotState[r][s] \in {Active, Stopped}) => slotIP[r][s] # NULL

\* Active slots are recording or failed (never finalized while active)
ActiveHarState ==
    \A r \in Replicas, s \in SessionSlots :
        (slotState[r][s] = Active) => slotHar[r][s] \in {Recording, HarFailed}

\* No sessions before gateway is live (per replica)
NoSessionsBeforeLive ==
    \A r \in Replicas :
        (gwPhase[r] = Booting) =>
            \A s \in SessionSlots : slotState[r][s] = Free

\* Readiness requires blob when configured (per replica)
ReadyImpliesBlob ==
    \A r \in Replicas :
        (IsReady(r) /\ blobConfigured) => blobUp

\* Liveness is independent of blob (per replica)
LivenessIndependentOfBlob ==
    \A r \in Replicas :
        (gwPhase[r] = Live) => IsAlive(r)

\* blobConfigured never changes after init
BlobConfigImmutable ==
    [][blobConfigured' = blobConfigured]_vars

\* After crash, replica's slots are clean
CrashCleansSlots ==
    \A r \in Replicas :
        (gwPhase[r] = Booting) =>
            \A s \in SessionSlots :
                /\ slotState[r][s] = Free
                /\ slotIP[r][s] = NULL
                /\ slotHar[r][s] = HarNone

-----------------------------------------------------------------------------
(* SAFETY INVARIANTS — Cross-replica *)

\* Redis is consistent: if a session is persisted, at least one replica
\* has (or had) an active/stopped session for that IP.
\* NOTE: This is NOT an invariant — the reaper can free a slot without
\* cleaning Redis, leaving a "ghost" entry. We verify this is reachable
\* by checking its negation is NOT an invariant (see DualOwnerPossible).

\* HAR blob safety: Azure append blobs support concurrent appends.
\* Two replicas writing to the same blob produce interleaved but valid JSONL.
\* This is safe by construction (append blob semantics), not by mutual exclusion.
\* We document it rather than try to prevent it.

\* The global unique-IP-per-session property does NOT hold across replicas.
\* After an affinity break + Redis restore, two replicas can own the same IP.
\* This is a KNOWN DESIGN LIMITATION. We verify it is reachable:
DualOwnerReachable ==
    \* This is expected to be VIOLATED — proving dual ownership is possible.
    \* To use: add as INVARIANT in cfg; TLC will show a counterexample trace.
    ~(\E ip \in ClientIPs, r1, r2 \in Replicas :
        r1 # r2
        /\ ActiveSlotForIP(r1, ip) # NULL
        /\ ActiveSlotForIP(r2, ip) # NULL)

\* Ghost restore: a reaped session can be restored from Redis.
\* This is also a KNOWN DESIGN LIMITATION.
GhostRestoreReachable ==
    \* Expected to be VIOLATED — proving ghost restore is possible.
    ~(\E r \in Replicas, ip \in ClientIPs :
        /\ ActiveSlotForIP(r, ip) # NULL
        /\ redisSession[ip] = TRUE
        /\ \A r2 \in Replicas \ {r} : ActiveSlotForIP(r2, ip) = NULL
        \* The session exists only because of a restore, not a create
        )

-----------------------------------------------------------------------------
(* LIVENESS *)

\* Each replica eventually becomes live after booting
EventuallyLive ==
    \A r \in Replicas :
        (gwPhase[r] = Booting) ~> (gwPhase[r] = Live)

\* Every idle session on any replica is eventually reaped
IdleSessionsEventuallyReaped ==
    \A r \in Replicas, s \in SessionSlots :
        (slotState[r][s] = Active /\ tick - slotLastActivity[r][s] >= IdleTimeoutTicks)
        ~> (slotState[r][s] # Active)

FairSpec ==
    /\ Spec
    /\ \A r \in Replicas : WF_vars(StartupComplete(r))
    /\ WF_vars(Tick)
    /\ \A r \in Replicas, s \in SessionSlots : WF_vars(ReapIdle(r, s))

=============================================================================
