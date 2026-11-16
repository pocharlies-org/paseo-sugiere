import type { PluginButtonContentProps, PluginButtonIconProps, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Pressable, Text, View } from "react-native";
import { autopilotStart, autopilotStop, suggestFeedback, suggestForce, suggestGet, suggestWatch, type Respuesta } from "../shared/contract.ts";
import { SUGGEST_WAIT_MS } from "../shared/suggest.ts";
import { insertSuggestion, registerPillAnchor } from "./composer-bridge.ts";
import { gira } from "./estrella.ts";

// One composer pill per idle agent (with an autopilot pair alive, also mid-turn): with a suggestion ready it opens the card, without one it is a small ✦ whose popover forces a
// generation now (Dani 19-10) or starts the agent's autopilot pair (Dani 07-11; then the ✦ is gold, or red when it needs a person). Nothing reaches the prompt without a press: a generation that finishes while another window is in
// front stays on this pill (Dani 02-11). Tapping a suggestion puts the text in the agent's prompt (composer-bridge.ts, web and
// desktop; Dani 18-10) and, where that cannot be done, opens the text already editable in place, and Enter sends it as the
// next user message (Dani 16-10: «editar» must edit the suggestion in place; 17-10: the two buttons were dead weight — the field
// is the whole card). The instruction the model gets is not edited here: it lives in the `sugiere` service. The text lives in
// the plugin server, and reaches this client through one held `suggest.watch` that answers only what changed (SC-5805).
type Agent = { id: string; workspaceId?: string | null; status: string; archivedAt?: string | null };

// «Garantizar plan»: what the anchored suggestion pursues — a step of the plan, new work for its own story and session, verifying,
// or closing the session once the plan is delivered.
const BADGE: Record<string, string> = { "en-plan": "▸", "trabajo-nuevo": "✚", verificar: "✓", cerrar: "■" };
// The star's color says the pill's state (Dani 07-11): amarillo = generating (the star spins), verde = a suggestion is ready,
// azul = it can be asked for, rojo = the last force failed. No ring around it (Dani 08-11: «saca el círculo y deja solo las
// estrellas»): the host paints the pill's frame with one global theme token, so the star is the only thing that carries the state.
// With an autopilot pair (the auditor session B pilots this one, 14-11): amarillo and spinning while it works or waits —
// `activa`, `pensando`, `esperando` (Dani 08-11: «tienes que tener la estrella amarilla mientras está en marcha rodando») —,
// rojo brillante beating when a person is needed (`humano`), rojo fijo when the auditor stopped answering (`degradada`: a
// message here does not clear it, so it does not beat), verde when the work was delivered (`entregada`).
const ESTADO_COLOR: Record<string, string> = {
  generando: "#eab308",
  lista: "#22c55e",
  pedible: "#3b82f6",
  error: "#ef4444",
  autopilot: "#eab308",
  pensando: "#eab308",
  humano: "#ff1744",
  degradada: "#ff1744",
  entregada: "#22c55e",
};
/** The pair of this agent as the supervisor's registry reports it (`file.autopilot.pares.v1`): `sin-par` when there is none,
 * `desconocido` when the registry could not be read, and otherwise the Par's estado with what the popover shows. */
type Par = { estado: string; motivo: string; desde?: string; actualizado?: string; pasos?: { seguidos: number; total: number }; ultimo_envio?: string; auditor?: string; key?: string | null; modelo?: string };
type Plan = { key: string; criterios: number };
const SIN_PAR: Par = { estado: "sin-par", motivo: "" };
/** Alive states: the auditor is piloting (or stuck needing a person) — the ✦ speaks for it and the popover offers «Parar».
 * `entregada` is terminal: the ✦ goes green and the popover is the form for the next pair. */
const esViva = (par: Par): boolean => ["activa", "pensando", "esperando", "humano", "degradada"].includes(par.estado);
/** What the autopilot is doing, in one line: the pill's label and the popover's status. */
export function autopilotLine({ estado, motivo }: Par): string {
  if (estado === "humano") return `necesita acción: ${motivo || "sin motivo"}`;
  if (estado === "degradada") return `autopilot degradado: ${motivo || "el auditor no responde"}`;
  if (estado === "esperando") return `esperando: ${motivo || "un evento"}`;
  if (estado === "pensando") return `autopilot: ${motivo || "el auditor está pensando"}`;
  if (estado === "entregada") return `entregado: ${motivo || "sin motivo"}`;
  if (estado === "desconocido") return `estado del autopilot desconocido${motivo ? `: ${motivo}` : ""}`;
  return "autopilot: trabajando";
}
function hace(iso: string | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `hace ${s} s` : s < 3600 ? `hace ${Math.round(s / 60)} min` : `hace ${Math.round(s / 3600)} h`;
}
/** The popover's lines under the status (Dani 08-11: «ver si está en marcha, cuántas lleva»): who wakes a wait, the step count,
 * since when the pair is on and when the supervisor last touched it, the last message it sent, and the auditor (B's title, or its id). */
export function autopilotDetails(par: Par, now = Date.now()): string[] {
  const out: string[] = [];
  if (par.estado === "esperando") out.push("sigue solo cuando llegue el EVENTO del supervisor");
  if (par.pasos) out.push(`${par.pasos.seguidos} pasos seguidos · ${par.pasos.total} en la sesión`);
  const cuando = [par.desde ? `en marcha ${hace(par.desde, now)}` : "", par.actualizado ? `actualizado ${hace(par.actualizado, now)}` : ""].filter(Boolean);
  if (cuando.length) out.push(cuando.join(" · "));
  if (par.ultimo_envio) out.push(`último envío: «${par.ultimo_envio.length > 140 ? `${par.ultimo_envio.slice(0, 140)}…` : par.ultimo_envio}»`);
  if (par.auditor) out.push(`auditor: ${par.auditor}`);
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
  par,
  plan,
  empezar,
  parar,
  sigue,
  models,
  layout: { compact },
}: PluginButtonContentProps & {
  text: string;
  send: (text: string) => void;
  agentId: string;
  onInserted: () => void;
  par: Par;
  plan: Plan | null;
  empezar: (input: { modo: "plan" | "prompt"; texto?: string; modelo?: string }) => Promise<{ ok: boolean; error?: string; par?: Par }>;
  parar: () => Promise<{ ok: boolean; error?: string; par?: Par }>;
  sigue: (alCambiar: (par: Par) => void) => () => void;
  models: () => Promise<{ id: string; label: string }[]>;
}) {
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
      <AutopilotPanel theme={theme} par={par} plan={plan} empezar={empezar} parar={parar} sigue={sigue} models={models} />
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
  // The beat shrinks the star instead of growing it: the host clips whatever leaves its icon box (Dani 08-11: «sale cortada»).
  const scale = pulso.interpolate({ inputRange: [0, 1], outputRange: [1, 0.82] });
  return (
    <View ref={node}>
      <Animated.View style={{ transform: [{ rotate: angle }, { scale }] }}>
        <Icon name="Sparkles" size={props.size} color={color} />
      </Animated.View>
    </View>
  );
}

// The autopilot of this agent (14-11): no longer a switch on the plugin's own loop — a start FORM. «Empezar» asks the supervisor
// (POST /autopilot/par) to create the auditor session B, which plans, audits against the criteria and writes A's next prompt;
// the plugin only starts and stops the pair and shows its state. The objective is the plan the session is anchored to (the
// anchor's ticket and criterion count) or a prompt the user writes; the auditor's model comes from A's provider, Opus 5.5 by
// default. While a pair is alive the popover is the status and the «Parar» button. Not «Sugerir automáticamente», which only proposes.
const MODELO_AUDITOR = "claude-opus-5-5";
type PanelProps = {
  theme: PluginButtonContentProps["theme"];
  par: Par;
  plan: Plan | null;
  empezar: (input: { modo: "plan" | "prompt"; texto?: string; modelo?: string }) => Promise<{ ok: boolean; error?: string; par?: Par }>;
  parar: () => Promise<{ ok: boolean; error?: string; par?: Par }>;
  sigue: (alCambiar: (par: Par) => void) => () => void;
  models: () => Promise<{ id: string; label: string }[]>;
  suggestNow?: () => void;
};
function AutopilotPanel({ theme, par: inicial, plan, empezar, parar, sigue, models, suggestNow }: PanelProps) {
  const [par, setPar] = useState(inicial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modo, setModo] = useState<"plan" | "prompt">(plan ? "plan" : "prompt");
  const [texto, setTexto] = useState("");
  const [modelos, setModelos] = useState<{ id: string; label: string }[]>([]);
  const [modelo, setModelo] = useState<string | null>(null);
  const viva = esViva(par);
  // Open, it follows its own pair: the host does not repaint an open popover, and «what is it doing» is the point. Each change
  // arrives with the client's held `suggest.watch` (SC-5805), not from a clock.
  useEffect(() => sigue(setPar), []);
  // The form asks A's provider for its models once (the same call the rutador's cards make); Opus 5.5 when it is offered.
  useEffect(() => {
    if (viva) return;
    void models().then((ms) => {
      setModelos(ms);
      setModelo((prev) => prev ?? (ms.some((m) => m.id === MODELO_AUDITOR) ? MODELO_AUDITOR : ms[0]?.id ?? null));
    }, () => {});
  }, [viva]);
  const pedir = (fn: () => Promise<{ ok: boolean; error?: string; par?: Par }>) => {
    setBusy(true);
    setError(null);
    void fn()
      .then((r) => {
        if (!r.ok) {
          setError(r.error ?? "el supervisor no respondió");
          return;
        }
        if (r.par) setPar(r.par);
      }, (e: unknown) => setError(e instanceof Error ? e.message : "el supervisor no respondió"))
      .finally(() => setBusy(false));
  };
  const opciones = plan
    ? [
        { label: `Plan vinculado · ${plan.key} · ${plan.criterios} criterios`, value: "plan" },
        { label: "Prompt", value: "prompt" },
      ]
    : [{ label: "Prompt", value: "prompt" }];
  return (
    <View style={{ gap: 4, minWidth: 260, maxWidth: 340 }}>
      {suggestNow && !viva ? <SettingsAction label="Sugerencia" hint="Propone ahora el siguiente mensaje; lo envías tú" actionLabel="Sugerir ahora" onPress={suggestNow} /> : null}
      {viva ? (
        <>
          <Text style={{ color: ESTADO_COLOR[par.estado] ?? theme.colors.foreground, fontSize: 13 }}>{autopilotLine(par)}</Text>
          {autopilotDetails(par).map((detail) => (
            <Text key={detail} style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{detail}</Text>
          ))}
          <SettingsAction
            label="Autopilot"
            hint="Para la pareja: el supervisor desregistra el par y archiva al auditor"
            actionLabel="Parar"
            onPress={() => pedir(parar)}
            disabled={busy}
          />
        </>
      ) : (
        <>
          {par.estado !== "sin-par" ? <Text style={{ color: ESTADO_COLOR[par.estado] ?? theme.colors.foregroundMuted, fontSize: 13 }}>{autopilotLine(par)}</Text> : null}
          <SettingsSelect
            label="Objetivo"
            hint="Qué persigue el auditor: el plan de paseo-plan de esta sesión, o un prompt que él convierte en plan"
            value={modo}
            options={opciones}
            disabled={busy}
            onValueChange={(v) => setModo(v === "plan" ? "plan" : "prompt")}
          />
          {modo === "plan" && plan ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{`${plan.key} · ${plan.criterios} criterios`}</Text>
          ) : modo === "prompt" ? (
            <TextInput
              accessibilityLabel="Objetivo para el auditor"
              multiline
              defaultValue={texto}
              onChangeText={setTexto}
              placeholder="Qué debe conseguir esta sesión, con sus criterios"
              style={{ height: LINE * 3, padding: 6, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, color: theme.colors.foreground, fontSize: 13, lineHeight: LINE, outlineWidth: 0, outlineColor: "transparent" }}
            />
          ) : null}
          <SettingsSelect
            label="Modelo del auditor"
            hint="El modelo con el que piensa la sesión B que pilota esta"
            value={modelo ?? ""}
            options={modelos.map((m) => ({ label: m.label, value: m.id }))}
            disabled={busy || modelos.length === 0}
            onValueChange={setModelo}
          />
          <SettingsAction
            label="Autopilot"
            hint="Una sesión auditora B planifica, audita contra los criterios y escribe el siguiente mensaje de esta; nunca implementa"
            actionLabel="Empezar"
            onPress={() => pedir(() => empezar({ modo, ...(modo === "prompt" ? { texto } : {}), ...(modelo ? { modelo } : {}) }))}
            disabled={busy || (modo === "prompt" && !texto.trim())}
          />
          {error ? <Text style={{ color: ESTADO_COLOR.error, fontSize: 13, maxWidth: 300 }}>{error}</Text> : null}
        </>
      )}
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
  const consumed = new Map<string, string>(); // the suggestion already put in the prompt: the held call must not bring it back until the next turn
  const pendingFor = new Map<string, boolean>(); // a force in flight: the pill's star spins in a yellow frame, disabled until it settles
  const errors = new Map<string, string>(); // the last force's failure, shown once by the popover
  const nadas = new Set<string>(); // the last force answered empty on purpose: the pill says «nada que sugerir», not a failure (Dani 15-11)
  const anchors = new Map<string, { en_plan: string | null; criterio: string | null }>(); // badge and criterion of the anchored suggestion
  const muted = new Set<string>(); // three «no es esto» in a row: the ✦ says it is quiet until clicked
  const noPills = new Map<string, ReturnType<PluginClientContext["addComposerPill"]>>(); // «no es esto», next to an anchored suggestion
  const autopilots = new Map<string, Par>(); // the pair of each agent, as the server last read it from the supervisor's registry
  const planes = new Map<string, Plan | null>(); // the plan the popover can link (the anchor's ticket and criterion count)
  const seguidores = new Map<string, Set<(par: Par) => void>>(); // the open popovers of each agent: told every change of its pair
  const plazos = new Map<string, ReturnType<typeof setTimeout>>(); // the deadline of a force in flight
  // A new pair repaints the pill only when what it paints changed (a rebuilt popover resets its form and flickers the star);
  // an open popover is told every change.
  const ponPar = (agentId: string, par: Par): boolean => {
    const antes = autopilots.get(agentId);
    autopilots.set(agentId, par);
    for (const sigue of seguidores.get(agentId) ?? []) sigue(par);
    return !antes || antes.estado !== par.estado || antes.motivo !== par.motivo || antes.ultimo_envio !== par.ultimo_envio;
  };
  const sigue = (agentId: string) => (alCambiar: (par: Par) => void) => {
    const suyos = seguidores.get(agentId) ?? new Set<(par: Par) => void>();
    seguidores.set(agentId, suyos.add(alCambiar));
    return () => void suyos.delete(alCambiar);
  };
  // Start and stop answer with the pair as the registry now has it, so the pill repaints at once, before the held call brings it.
  const refrescar = async (agentId: string): Promise<{ par: Par; plan: Plan | null }> => {
    const r = await client.rpc(suggestGet, { agentId });
    const par = r.autopilot ?? SIN_PAR;
    planes.set(agentId, r.plan ?? null);
    const current = agents.get(agentId);
    if (ponPar(agentId, par) && current) show(current);
    return { par, plan: r.plan ?? null };
  };
  const empezar = (agentId: string) => async (input: { modo: "plan" | "prompt"; texto?: string; modelo?: string }) => {
    const r = await client.rpc(autopilotStart, { agentId, ...input });
    return r.ok ? { ...r, ...(await refrescar(agentId)) } : r;
  };
  const parar = (agentId: string) => async () => {
    const r = await client.rpc(autopilotStop, { agentId });
    return r.ok ? { ...r, ...(await refrescar(agentId)) } : r;
  };
  // The auditor's model list: A's provider, the same call the rutador's cards make (herramientas.ts).
  const modelos = (agentId: string) => async (): Promise<{ id: string; label: string }[]> => {
    try {
      const agent = (await client.paseo.agents.ref(agentId).refresh())?.agent;
      if (!agent) return [];
      const list = await client.paseo.providers.listModels(agent.provider);
      return (list.models ?? []).map((m) => ({ id: m.id, label: m.label ?? m.id }));
    } catch {
      return [];
    }
  };
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
    nadas.delete(id);
    compactFor.delete(id);
    compactReported.delete(id);
    estadoFor.delete(id);
    autopilots.delete(id);
    planes.delete(id);
    seguidores.delete(id);
    clearTimeout(plazos.get(id));
    plazos.delete(id);
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
      nadas.delete(agent.id);
    }
    const text = agent.status === "idle" ? (texts.get(agent.id) ?? null) : null;
    const pending = pendingFor.get(agent.id) ?? false;
    const error = errors.get(agent.id) ?? null;
    const nada = nadas.has(agent.id);
    // The pair is the supervisor's, not this plugin's: whatever the last turn did, the registry says what the auditor is doing.
    // A page opened mid-turn learns it from the held call's first, complete answer (SC-5805).
    const par = autopilots.get(agent.id) ?? SIN_PAR;
    const piloted = par.estado === "sin-par" || par.estado === "desconocido" ? null : par;
    estadoFor.set(agent.id, piloted
      ? (["humano", "degradada", "pensando", "entregada"].includes(piloted.estado) ? piloted.estado : "autopilot")
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
        <AutopilotPanel
          theme={props.theme}
          par={par}
          plan={planes.get(agent.id) ?? null}
          empezar={empezar(agent.id)}
          parar={parar(agent.id)}
          sigue={sigue(agent.id)}
          models={modelos(agent.id)}
          suggestNow={suggestNow && (() => { props.close(); void suggestNow(); })}
        />
      ),
    });
    // The pair speaks with the ✦ alone: gold and turning while the auditor pilots it, red when it needs a person or stopped
    // answering, green when delivered; its popover is the status and the «Parar» button.
    const button = piloted ? {
      title: autopilotLine(piloted),
      icon: SuggestIcon,
      label: compact ? "\u200b" : piloted.estado === "activa" ? "autopilot" : autopilotLine(piloted).slice(0, 60),
      visible: true, // also while a turn runs: the stop button must be reachable mid-turn
      disabled: false,
      behavior: panel(),
    } : {
      title: text ? (badge ? `${badge} ${meta?.criterio ?? ""}`.trim() : "Suggested next message")
        : pending ? "Generating…" : error ? "Last suggestion failed"
        : nada ? "No hay nada que sugerir: el trabajo está hecho o lo siguiente es tuyo. Púlsala para pedir otra."
        : quiet ? "La ✦ se calla: tres «no es esto» seguidos. Púlsala para pedir otra." : "Suggest now",
      icon: SuggestIcon,
      label: !compact && text ? (badge ? `${badge} ${meta?.criterio ? `${meta.criterio} · ` : ""}${text}` : text)
        : text && badge ? badge : pending ? "\u200b" : error ? "!" : nada ? "nada que sugerir" : quiet ? "callada" : "\u200b", // sin «…» ni ✦ repetida (la ✦ es el icono, Dani 08-11): la estrella amarilla gira (Dani 07-11); el host rechaza label vacía o en blanco (validation.ts requireText), el espacio de ancho cero la pasa y no se ve
      // Idle agents always carry the pill: with a suggestion it opens the card, without one the small ✦ opens «Sugerir ahora»,
      // which forces a generation (Dani 19-10), next to the autopilot form (Dani 07-11, now the auditor's start form); it spins
      // while the generation resolves and shows the failure once if it does not.
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
                par={par}
                plan={planes.get(agent.id) ?? null}
                empezar={empezar(agent.id)}
                parar={parar(agent.id)}
                sigue={sigue(agent.id)}
                models={modelos(agent.id)}
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
                // The click cannot wait for the answer: the generation outlives the host's 60 s RPC timeout (measured 19-10).
                // The pill spins from the click; the held `suggest.watch` brings the end (SC-5805: no more polling every 2 s): the
                // text waits on the pill until its button is pressed, error shows once (Dani 19-10, 02-11).
                pendingFor.set(agent.id, true);
                errors.delete(agent.id);
                nadas.delete(agent.id);
                show(agents.get(agent.id) ?? agent);
                const { started } = await client.rpc(suggestForce, { agentId: agent.id }).catch((error) => {
                  console.error("suggest: el rpc force falló", error);
                  return { started: false };
                });
                if (stopped) return;
                if (!started) { // off switch
                  pendingFor.delete(agent.id);
                  show(agents.get(agent.id) ?? agent);
                  return;
                }
                muted.delete(agent.id); // the click speaks for the user: the server reset the streak too
                clearTimeout(plazos.get(agent.id));
                plazos.set(agent.id, setTimeout(() => { // after the service's wait and the plugin server's margin over it
                  plazos.delete(agent.id);
                  const current = agents.get(agent.id);
                  if (stopped || !current || !pendingFor.has(agent.id)) return;
                  pendingFor.delete(agent.id);
                  errors.set(agent.id, "el modelo no respondió a tiempo");
                  show(current);
                }, SUGGEST_WAIT_MS + 30_000));
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
          pide();
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") remove(update.agentId);
          else show(update.agent as Agent);
          pide();
        },
      });
    })
    .catch((error) => {
      if (!stopped) console.error("suggest: agent observation failed", error);
    });
  // SC-5805: one held `suggest.watch` for every agent this client shows, instead of a `suggest.get` per idle agent every 10 s
  // (~88 % of the daemon's plugin RPCs on 16-11). The server answers only what changed — everything on the first call — and
  // the next call goes out when the last one answers, never on a clock. A new set of agents restarts it asking for everything;
  // a failure (daemon gone, plugin reloading) waits for the next agent change, which asks again.
  let version = 0;
  let pidiendo: AbortController | null = null;
  let pedidas = "";
  const pide = () => {
    const ids = [...agents.keys()].sort();
    const clave = ids.join(" ");
    if (stopped || (pidiendo && clave === pedidas)) return;
    pidiendo?.abort();
    if (clave !== pedidas) version = 0; // an answer only covers the agents it was asked for
    const esta = new AbortController();
    pidiendo = esta;
    pedidas = clave;
    void client.rpc(suggestWatch, { agentes: ids, since: version }).then(
      (r) => {
        if (esta.signal.aborted || stopped) return;
        pidiendo = null;
        version = r.version;
        for (const [id, respuesta] of Object.entries(r.agentes)) aplica(id, respuesta);
        pide();
      },
      () => {
        if (esta.signal.aborted) return;
        pidiendo = null;
        version = 0;
      },
    );
  };
  // What the server answers for one agent: the suggestion, its anchor, the quiet streak and the pair; a force of this client
  // settles here when the answer is no longer pending.
  const aplica = (agentId: string, r: Respuesta) => {
    const agent = agents.get(agentId);
    if (stopped || !agent) return;
    const forzada = pendingFor.has(agentId) && !r.pending && (r.text !== null || r.error !== null || r.nada);
    const shown = r.text === consumed.get(agentId) && !forzada ? null : r.text; // a used one does not come back until the next turn
    let changed = ponPar(agentId, r.autopilot) || texts.get(agentId) !== shown || muted.has(agentId) !== r.muted;
    planes.set(agentId, r.plan);
    texts.set(agentId, shown);
    anchors.set(agentId, { en_plan: r.en_plan, criterio: r.criterio });
    if (r.muted) muted.add(agentId);
    else muted.delete(agentId);
    if (forzada) {
      pendingFor.delete(agentId);
      clearTimeout(plazos.get(agentId));
      plazos.delete(agentId);
      if (r.error) errors.set(agentId, r.error);
      else if (r.nada && r.text === null) nadas.add(agentId);
      changed = true;
    }
    if (changed) show(agent);
  };

  return () => {
    stopped = true;
    lifetime.abort();
    pidiendo?.abort();
    for (const id of [...pills.keys()]) remove(id);
  };
}
