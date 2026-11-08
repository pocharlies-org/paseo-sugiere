import type { PluginButtonContentProps, PluginButtonIconProps, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Pressable, Text, View } from "react-native";
import { autopilotSet, suggestFeedback, suggestForce, suggestGet } from "../shared/contract.ts";
import { SUGGEST_WAIT_MS } from "../shared/suggest.ts";
import { insertSuggestion, registerPillAnchor } from "./composer-bridge.ts";
import { gira, marco } from "./marco.ts";

// One composer pill per idle agent (with the autopilot on, also mid-turn): with a suggestion ready it opens the card, without one it is a small ✦ whose popover forces a
// generation now (Dani 19-10) or switches the agent's autopilot on (Dani 07-11; then the ✦ is gold, or red when it needs a person). Nothing reaches the prompt without a press: a generation that finishes while another window is in
// front stays on this pill (Dani 02-11). Tapping a suggestion puts the text in the agent's prompt (composer-bridge.ts, web and
// desktop; Dani 18-10) and, where that cannot be done, opens the text already editable in place, and Enter sends it as the
// next user message (Dani 16-10: «editar» must edit the suggestion in place; 17-10: the two buttons were dead weight — the field
// is the whole card). The instruction the model gets is not edited here: it lives in the `sugiere` service. The text lives in
// the plugin server — this only polls for idle agents, so a suggestion is never asked for while a turn is running.
type Agent = { id: string; workspaceId?: string | null; status: string; archivedAt?: string | null };

const POLL_MS = 10_000;
// «Garantizar plan»: what the anchored suggestion pursues — a step of the plan, new work for its own story and session, verifying,
// or closing the session once the plan is delivered.
const BADGE: Record<string, string> = { "en-plan": "▸", "trabajo-nuevo": "✚", verificar: "✓", cerrar: "■" };
// The recuadro of the icon says the pill's state (Dani 07-11): amarillo = generating (the star spins), verde = a suggestion is
// ready, azul = it can be asked for, rojo = the last force failed. The host paints the pill's own frame with a global theme token
// (`borderAccent`, no per-pill hook in the plugin API), so the state frame is the icon's box — it carries the color on every client.
// With the autopilot on: amarillo and spinning the whole time it is on — working, asking the service or waiting for an event
// (Dani 08-11: «tienes que tener la estrella amarilla mientras está en marcha rodando») —, rojo brillante pulsing when it needs a person.
const ESTADO_COLOR: Record<string, string> = {
  generando: "#eab308",
  lista: "#22c55e",
  pedible: "#3b82f6",
  error: "#ef4444",
  autopilot: "#eab308",
  pensando: "#eab308",
  humano: "#ff1744",
};
type Autopilot = { on: boolean; estado: string; motivo: string; desde?: string; decidido?: string; pasos?: { seguidos: number; total: number }; enviado?: string };
const OFF: Autopilot = { on: false, estado: "apagado", motivo: "" };
/** What the autopilot is doing, in one line: the pill's label and the popover's status. */
export function autopilotLine({ estado, motivo }: Autopilot): string {
  if (estado === "humano") return `necesita acción: ${motivo || "sin motivo"}`;
  if (estado === "esperando") return `esperando: ${motivo || "un evento"}`;
  if (estado === "pensando") return `autopilot: ${motivo || "pidiendo el siguiente paso"}`;
  return "autopilot: trabajando";
}
function hace(iso: string | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `hace ${s} s` : s < 3600 ? `hace ${Math.round(s / 60)} min` : `hace ${Math.round(s / 3600)} h`;
}
/** The popover's lines under the status (Dani 08-11: «ver si está en marcha, cuántas lleva»): who wakes a wait, the step count,
 * since when it is on and when the service last decided, and the last message it sent. */
export function autopilotDetails(a: Autopilot, now = Date.now()): string[] {
  const out: string[] = [];
  if (a.estado === "esperando") out.push("sigue solo cuando llegue el EVENTO del supervisor");
  if (a.pasos) out.push(`${a.pasos.seguidos} pasos seguidos · ${a.pasos.total} en la sesión`);
  const cuando = [a.desde ? `encendido ${hace(a.desde, now)}` : "", a.decidido ? `última decisión ${hace(a.decidido, now)}` : ""].filter(Boolean);
  if (cuando.length) out.push(cuando.join(" · "));
  if (a.enviado) out.push(`último envío: «${a.enviado.length > 140 ? `${a.enviado.slice(0, 140)}…` : a.enviado}»`);
  return out;
}
const LINE = 18; // one row of the field; `rows` is not in the host's react-native types, so the height is set from here
const MOBILE_LINE = 22;
// Mobile field: sized ONCE from the text when the card opens (4 to 10 rows), never while editing — see SuggestCard.
// shortcut: rows are estimated at ~34 characters per row of an iPhone-width sheet; measure the width if wrapping looks off.
export function textRows(text: string): number {
  return text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 34)), 0);
}

// The popover of the host is already the frame: the card adds no border and no fill (Dani 17-10: «la ventana es muy grande, más
// minimalista»). On mobile the field has a FIXED height chosen when the card opens (Dani 01-11: a long text in two lines did not
// look scrollable): up to ten rows, framed so its edge shows that more text continues below, plus a hint when it overflows. Fixed: on mobile the card is a bottom sheet with dynamic sizing, and a field that resizes
// itself when the keyboard opens makes that sheet re-measure and collapse (Dani 20-10: tapping the text closed the window). The text
// scrolls inside the field instead of growing it. Enter sends: with `blurOnSubmit` on a multiline field react-native-web fires
// onSubmitEditing on Enter and swallows the newline, Shift+Enter still wraps. Compact layouts put a touch-sized send button below
// the field. The host TextInput registers focus with the sheet so opening the keyboard does not hide it. On mount it first tries
// the prompt, draws nothing while it decides, and shows up only if the bridge could not.
function SuggestCard({
  text,
  theme,
  close,
  send,
  agentId,
  onInserted,
  autopilot,
  toggle,
  refresh,
  layout: { compact },
}: PluginButtonContentProps & { text: string; send: (text: string) => void; agentId: string; onInserted: () => void; autopilot: Autopilot; toggle: (on: boolean) => Promise<Autopilot>; refresh: () => Promise<Autopilot> }) {
  const [inserted, setInserted] = useState<boolean | null>(null); // null while the bridge decides
  useEffect(() => {
    const done = text !== "" && insertSuggestion(agentId, text);
    setInserted(done);
    if (done) {
      close();
      onInserted();
    }
  }, []);
  const [suggestion, setSuggestion] = useState<string | null>(null); // the edited suggestion, null until the user touches the field
  const [rows] = useState(() => Math.min(10, Math.max(4, textRows(text))));
  const overflows = compact && textRows(text) > 10;
  const styles = useMemo(
    () => ({
      // outlineWidth 0 + outlineColor transparent: el anillo de foco del host se pinta con `outline`, y así lo apagan también los
      // inputs propios de Paseo (composer, buscar del panel, revisión). Medido 17-10: sin esto, rectángulo verde alrededor (Dani: «cutre»).
      row: { flexDirection: compact ? "column" as const : "row" as const, alignItems: compact ? "stretch" as const : "flex-end" as const, gap: 8 },
      input: compact
        ? { height: rows * MOBILE_LINE + 20, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, color: theme.colors.foreground, fontSize: 16, lineHeight: MOBILE_LINE, outlineWidth: 0, outlineColor: "transparent" }
        : { flex: 1, height: LINE * 2, padding: 0, color: theme.colors.foreground, fontSize: 13, lineHeight: LINE, outlineWidth: 0, outlineColor: "transparent" },
      hint: { color: theme.colors.foregroundMuted, fontSize: 13 },
      send: { minWidth: compact ? 44 : 20, height: compact ? 44 : 20, paddingHorizontal: compact ? 16 : 0, ...(compact ? { alignSelf: "flex-start" as const } : {}), borderRadius: 10, alignItems: "center" as const, justifyContent: "center" as const, backgroundColor: theme.colors.accent },
      arrow: { color: theme.colors.accentForeground, fontSize: 13, lineHeight: 16 },
    }),
    [theme, compact, rows],
  );
  const submit = () => {
    const t = (suggestion ?? text).trim();
    if (t) send(t);
    close();
  };
  if (inserted !== false) return null;
  return (
    <View style={{ gap: 8 }}>
      <View style={styles.row}>
        <TextInput accessibilityLabel="Suggested next message" multiline blurOnSubmit defaultValue={text} onChangeText={setSuggestion} onSubmitEditing={submit} style={styles.input} />
        {overflows ? <Text style={styles.hint}>Desliza dentro del texto para ver el resto</Text> : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Send" onPress={submit} style={styles.send}>
          <Text style={styles.arrow}>{compact ? "Send ↑" : "↑"}</Text>
        </Pressable>
      </View>
      <AutopilotPanel theme={theme} autopilot={autopilot} toggle={toggle} refresh={refresh} />
    </View>
  );
}

// The host reports `layout.compact` to components only, never to the pill registration (Dani 02-11: «en el móvil acaban
// amontonados»): the icon, the pill's only component, hands it over here and the label drops the text from there.
const compactFor = new Map<string, boolean>();
const compactReported = new Map<string, (compact: boolean) => void>();
// The state of each pill, set by show() before the host re-renders the icon (the icon component gets no props of its own).
const estadoFor = new Map<string, string>();

// Movement only when the user has not asked the system for less of it.
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduced, () => {});
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => subscription?.remove();
  }, []);
  return reduced;
}

// The pill's icon is also the anchor of the composer bridge: the popover's content is portaled to body, the icon sits in the pane.
function SuggestIcon(props: PluginButtonIconProps) {
  const node = useRef<View>(null);
  const agentId = props.context === "agent" ? props.agentId : null;
  const { compact } = props.layout;
  const estado = (agentId && estadoFor.get(agentId)) || "pedible";
  const color = ESTADO_COLOR[estado] ?? ESTADO_COLOR.pedible;
  const giro = useRef(new Animated.Value(0)).current;
  const pulso = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();
  useEffect(() => {
    if (agentId) compactReported.get(agentId)?.(compact);
  }, [agentId, compact]);
  useEffect(() => {
    // A compact layout can host the agent in a sheet with no composer of its own, where the climb could meet another agent's.
    if (!agentId || compact || !node.current) return;
    return registerPillAnchor(agentId, node.current as unknown as Element);
  }, [agentId, compact]);
  useEffect(() => {
    // Mientras genera o el autopilot está en marcha, la estrella gira sin parar (Dani 07-11: «como un gif, moviéndose»).
    if (!gira(estado) || reduced) {
      giro.setValue(0);
      return;
    }
    const loop = Animated.loop(Animated.timing(giro, { toValue: 1, duration: 1400, easing: Easing.linear, useNativeDriver: false }));
    loop.start();
    return () => loop.stop();
  }, [estado, giro, reduced]);
  useEffect(() => {
    // The red asks for a person: it beats until someone answers (Dani 07-11), still red without the beat for reduced motion.
    if (estado !== "humano" || reduced) {
      pulso.setValue(0);
      return;
    }
    const beat = (toValue: number) => Animated.timing(pulso, { toValue, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: false });
    const loop = Animated.loop(Animated.sequence([beat(1), beat(0)]));
    loop.start();
    return () => loop.stop();
  }, [estado, pulso, reduced]);
  const angle = giro.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  const m = marco(estado);
  const scale = pulso.interpolate({ inputRange: [0, 1], outputRange: [1, m.latido] });
  const halo = pulso.interpolate({ inputRange: [0, 1], outputRange: ["rgba(255,23,68,0.15)", "rgba(255,23,68,0.45)"] });
  return (
    <View ref={node}>
      <Animated.View
        style={{
          width: m.lado,
          height: m.lado,
          borderWidth: m.borde,
          borderRadius: m.lado / 2,
          borderColor: color,
          alignItems: "center",
          justifyContent: "center",
          ...(estado === "humano" ? { backgroundColor: halo, transform: [{ scale }] } : {}),
        }}
      >
        <Animated.View style={{ transform: [{ rotate: angle }] }}>
          <Icon name="Sparkles" size={m.icono} color={color} />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

// The «Autopilot» switch (Dani 07-11): on, the session is piloted alone until it is done — at the end of every turn the sugiere
// service says what to do and the plugin obeys. Not «Sugerir automáticamente», which only proposes messages for the user to send.
// In the ✦'s popover (with «Sugerir ahora» while it is off) and in the mobile card.
function AutopilotPanel({ theme, autopilot, toggle, refresh, suggestNow }: { theme: PluginButtonContentProps["theme"]; autopilot: Autopilot; toggle: (on: boolean) => Promise<Autopilot>; refresh: () => Promise<Autopilot>; suggestNow?: () => void }) {
  const [state, setState] = useState(autopilot);
  const [busy, setBusy] = useState(false);
  // Open, it reads its own state every few seconds: the host does not repaint an open popover, and «what is it doing» is the point.
  useEffect(() => {
    if (!state.on) return;
    const timer = setInterval(() => void refresh().then(setState, () => {}), 3_000);
    return () => clearInterval(timer);
  }, [state.on]);
  return (
    <View style={{ gap: 4, minWidth: 260, maxWidth: 340 }}>
      {suggestNow && !state.on ? <SettingsAction label="Sugerencia" hint="Propone ahora el siguiente mensaje; lo envías tú" actionLabel="Sugerir ahora" onPress={suggestNow} /> : null}
      <SettingsSwitch
        label="Autopilot"
        hint="Pilota esta sesión sola hasta terminar: envía cada paso, espera los eventos y archiva al entregar. Se pone en rojo si necesita a una persona."
        value={state.on}
        disabled={busy}
        onValueChange={(on) => {
          setBusy(true);
          void toggle(on).then(setState, () => {}).finally(() => setBusy(false));
        }}
      />
      {state.on ? (
        <Text style={{ color: state.estado === "humano" ? ESTADO_COLOR.humano : theme.colors.foreground, fontSize: 13 }}>{autopilotLine(state)}</Text>
      ) : null}
      {state.on ? autopilotDetails(state).map((detail) => (
        <Text key={detail} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{detail}</Text>
      )) : null}
    </View>
  );
}

// The error of a failed force, shown once (Dani 19-10: «un error claro si no va»): opening it clears it, so the next click forces again.
function SuggestError({ theme, message, onSeen }: PluginButtonContentProps & { message: string; onSeen: () => void }) {
  useEffect(() => onSeen(), []);
  return <Text style={{ color: theme.colors.foreground, fontSize: 13, maxWidth: 280 }}>{message}</Text>;
}

export function addSuggestPill(client: PluginClientContext): () => void {
  const agents = new Map<string, Agent>();
  const pills = new Map<string, ReturnType<PluginClientContext["addComposerPill"]>>();
  const texts = new Map<string, string | null>();
  const consumed = new Map<string, string>(); // the suggestion already put in the prompt: the poll must not bring it back until the next turn
  const pendingFor = new Map<string, boolean>(); // a force in flight: the pill's star spins in a yellow frame, disabled until it settles
  const errors = new Map<string, string>(); // the last force's failure, shown once by the popover
  const anchors = new Map<string, { en_plan: string | null; criterio: string | null }>(); // badge and criterion of the anchored suggestion
  const muted = new Set<string>(); // three «no es esto» in a row: the ✦ says it is quiet until clicked
  const noPills = new Map<string, ReturnType<PluginClientContext["addComposerPill"]>>(); // «no es esto», next to an anchored suggestion
  const autopilots = new Map<string, Autopilot>(); // the autopilot of each agent, as the server last reported it
  const toggle = (agentId: string) => async (on: boolean) => {
    const next = await client.rpc(autopilotSet, { agentId, on });
    autopilots.set(agentId, next);
    const current = agents.get(agentId);
    if (current) show(current);
    return next;
  };
  const refresh = (agentId: string) => () => client.rpc(suggestGet, { agentId }).then(({ autopilot = OFF }) => autopilot);
  const feedback = (agentId: string, verdict: "no-es-esto" | "usada") =>
    client.rpc(suggestFeedback, { agentId, verdict }).catch(() => ({ muted: false }));
  let stopped = false;
  const lifetime = new AbortController();

  const remove = (id: string) => {
    pills.get(id)?.remove();
    pills.delete(id);
    noPills.get(id)?.remove();
    noPills.delete(id);
    anchors.delete(id);
    muted.delete(id);
    agents.delete(id);
    texts.delete(id);
    consumed.delete(id);
    pendingFor.delete(id);
    errors.delete(id);
    compactFor.delete(id);
    compactReported.delete(id);
    estadoFor.delete(id);
    autopilots.delete(id);
  };
  const show = (agent: Agent) => {
    if (stopped) return;
    if (!agent.workspaceId || agent.archivedAt) return remove(agent.id);
    agents.set(agent.id, agent);
    if (agent.status !== "idle") {
      texts.delete(agent.id); // a returning idle must not resurrect the previous suggestion
      consumed.delete(agent.id);
      pendingFor.delete(agent.id);
      errors.delete(agent.id);
    }
    const text = agent.status === "idle" ? (texts.get(agent.id) ?? null) : null;
    const pending = pendingFor.get(agent.id) ?? false;
    const error = errors.get(agent.id) ?? null;
    // While a turn runs the autopilot is working, whatever it last reported; idle, the poll brings what it decided.
    const autopilot = autopilots.get(agent.id) ?? OFF;
    const piloted = autopilot.on ? (agent.status === "idle" ? autopilot : { ...autopilot, estado: "activo", motivo: "" }) : null;
    estadoFor.set(agent.id, piloted
      ? (piloted.estado === "humano" || piloted.estado === "pensando" ? piloted.estado : "autopilot")
      : pending ? "generando" : text ? "lista" : error ? "error" : "pedible");
    const pill = pills.get(agent.id);
    compactReported.set(agent.id, (next) => {
      if (compactFor.get(agent.id) === next) return;
      compactFor.set(agent.id, next);
      const current = agents.get(agent.id);
      if (current) show(current);
    });
    // The suggestion's text goes without a ✦ of its own (the icon is already a Sparkles). The host refuses an empty label
    // («Plugin button needs label», so no pill at all: Dani 02-11, «no sale el botón»): idle and compact fall back to a zero-width space.
    const compact = compactFor.get(agent.id) ?? false;
    // An anchored suggestion carries its badge and the criterion it pursues; only the text goes into the prompt.
    const meta = text ? anchors.get(agent.id) : undefined;
    const badge = meta?.en_plan ? (BADGE[meta.en_plan] ?? "") : "";
    const quiet = !text && !pending && !error && muted.has(agent.id);
    const panel = (suggestNow?: () => void) => ({
      kind: "popover" as const,
      Content: (props: PluginButtonContentProps) => (
        <AutopilotPanel theme={props.theme} autopilot={autopilot} toggle={toggle(agent.id)} refresh={refresh(agent.id)} suggestNow={suggestNow && (() => { props.close(); void suggestNow(); })} />
      ),
    });
    // The autopilot speaks with the ✦ alone: gold while it works or waits, red when it needs a person, and its popover is the switch.
    const button = piloted ? {
      title: autopilotLine(piloted),
      icon: SuggestIcon,
      label: compact ? "\u200b" : piloted.estado === "activo" ? "autopilot" : autopilotLine(piloted).slice(0, 60),
      visible: true, // also while a turn runs: the switch must be reachable to stop it mid-turn
      disabled: false,
      behavior: panel(),
    } : {
      title: text ? (badge ? `${badge} ${meta?.criterio ?? ""}`.trim() : "Suggested next message")
        : pending ? "Generating…" : error ? "Last suggestion failed"
        : quiet ? "La ✦ se calla: tres «no es esto» seguidos. Púlsala para pedir otra." : "Suggest now",
      icon: SuggestIcon,
      label: !compact && text ? (badge ? `${badge} ${meta?.criterio ? `${meta.criterio} · ` : ""}${text}` : text)
        : text && badge ? badge : pending ? "\u200b" : error ? "!" : quiet ? "callada" : "\u200b", // sin «…» ni ✦ repetida (la ✦ es el icono, Dani 08-11): la estrella amarilla gira (Dani 07-11); el host rechaza label vacía o en blanco (validation.ts requireText), el espacio de ancho cero la pasa y no se ve
      // Idle agents always carry the pill: with a suggestion it opens the card, without one the small ✦ opens «Sugerir ahora»,
      // which forces a generation (Dani 19-10), next to the Autopilot switch (Dani 07-11); it spins while the generation resolves
      // and shows the failure once if it does not.
      // Hidden while a turn runs — a suggestion is never asked for mid-turn.
      visible: agent.status === "idle",
      disabled: pending,
      behavior: text
        ? {
            kind: "popover" as const,
            Content: (props: PluginButtonContentProps) => (
              <SuggestCard
                {...props}
                text={text}
                agentId={agent.id}
                autopilot={autopilot}
                toggle={toggle(agent.id)}
                refresh={refresh(agent.id)}
                onInserted={() => {
                  consumed.set(agent.id, text);
                  texts.set(agent.id, null);
                  void feedback(agent.id, "usada");
                  show(agents.get(agent.id) ?? agent); // back to the plain ✦
                }}
                send={(t) => {
                  texts.delete(agent.id);
                  void feedback(agent.id, "usada");
                  void client.paseo.agents.ref(agent.id).send(t);
                }}
              />
            ),
          }
        : error
          ? {
              kind: "popover" as const,
              Content: (props: PluginButtonContentProps) => (
                <SuggestError {...props} message={error} onSeen={() => { errors.delete(agent.id); show(agents.get(agent.id) ?? agent); }} />
              ),
            }
          : panel(async () => {
                const { started } = await client.rpc(suggestForce, { agentId: agent.id }).catch((error) => {
                  console.error("suggest: el rpc force falló", error);
                  return { started: false };
                });
                if (stopped || !started) return; // off switch
                muted.delete(agent.id); // the click speaks for the user: the server reset the streak too
                // The click cannot wait for the answer: the generation outlives the host's 60 s RPC timeout (measured 19-10).
                // Fast-poll until it settles: the text waits on the pill until its button is pressed, error shows once; the pill spins meanwhile (Dani 19-10, 02-11).
                pendingFor.set(agent.id, true);
                errors.delete(agent.id);
                show(agents.get(agent.id) ?? agent);
                const deadline = Date.now() + SUGGEST_WAIT_MS + 30_000; // after the service's wait and the plugin server's margin over it
                const id = setInterval(() => {
                  const current = agents.get(agent.id);
                  if (stopped || !current || current.status !== "idle") {
                    clearInterval(id);
                    pendingFor.delete(agent.id);
                    if (current) show(current);
                    return;
                  }
                  if (Date.now() > deadline) {
                    clearInterval(id);
                    pendingFor.delete(agent.id);
                    errors.set(agent.id, "el modelo no respondió a tiempo");
                    show(current);
                    return;
                  }
                  void client.rpc(suggestGet, { agentId: agent.id }).then(
                    ({ text: forced, error: failed, en_plan, criterio }) => {
                      if (!forced && !failed) return; // still generating: keep spinning
                      clearInterval(id);
                      pendingFor.delete(agent.id);
                      if (failed) {
                        errors.set(agent.id, failed);
                      } else {
                        texts.set(agent.id, forced!); // it waits on this pill's button: injecting it here would write into whichever window is in front (Dani 02-11)
                        anchors.set(agent.id, { en_plan, criterio });
                      }
                      show(agents.get(agent.id) ?? current);
                    },
                    () => {},
                  );
                }, 2000);
              }),
    };
    if (pill) pill.update(button);
    else pills.set(agent.id, client.addComposerPill({ id: "suggest", workspaceId: agent.workspaceId, agentId: agent.id, button }));
    // «no es esto» only next to an anchored suggestion; three in a row and the server stops generating until the ✦ is clicked.
    const no = {
      title: "No es esto: descarta la sugerencia (tres seguidos y la ✦ se calla)",
      icon: "ThumbsDown",
      label: "no es esto",
      visible: agent.status === "idle" && badge !== "" && !piloted,
      behavior: {
        kind: "action" as const,
        onPress: async () => {
          const { muted: quieted } = await feedback(agent.id, "no-es-esto");
          texts.set(agent.id, null);
          anchors.delete(agent.id);
          if (quieted) muted.add(agent.id);
          show(agents.get(agent.id) ?? agent);
        },
      },
    };
    const noPill = noPills.get(agent.id);
    if (noPill) noPill.update(no);
    else noPills.set(agent.id, client.addComposerPill({ id: "suggest-no", workspaceId: agent.workspaceId, agentId: agent.id, button: no }));
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const id of [...pills.keys()]) remove(id);
          for (const { agent } of entries) show(agent as Agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") remove(update.agentId);
          else show(update.agent as Agent);
        },
      });
    })
    .catch((error) => {
      if (!stopped) console.error("suggest: agent observation failed", error);
    });
  const poll = setInterval(() => {
    for (const agent of agents.values()) {
      if (agent.status !== "idle") continue;
      void client.rpc(suggestGet, { agentId: agent.id }).then(
        ({ text, en_plan, criterio, muted: quiet, autopilot = OFF }) => {
          if (stopped) return;
          const shown = text === consumed.get(agent.id) ? null : text;
          const before = autopilots.get(agent.id) ?? OFF;
          const changed = texts.get(agent.id) !== shown || muted.has(agent.id) !== quiet
            || before.on !== autopilot.on || before.estado !== autopilot.estado || before.motivo !== autopilot.motivo;
          autopilots.set(agent.id, autopilot);
          texts.set(agent.id, shown);
          anchors.set(agent.id, { en_plan, criterio });
          if (quiet) muted.add(agent.id);
          else muted.delete(agent.id);
          if (changed) show(agent);
        },
        () => {},
      );
    }
  }, POLL_MS);

  return () => {
    stopped = true;
    lifetime.abort();
    clearInterval(poll);
    for (const id of [...pills.keys()]) remove(id);
  };
}
