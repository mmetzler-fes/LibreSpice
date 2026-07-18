/**
 * Current-sensing sources for `.ac` runs.
 *
 * ngspice cannot report a resistor's or capacitor's current in an AC analysis.
 * Only devices with a real branch equation (V/E/H/L) have an `i(name)` vector;
 * everything else has a current solely because `.options savecurrents` computes
 * it — and asking for one during `.ac` breaks the engine's result write:
 *
 *     Warning from checkvalid: vector @c1[i] is not available or has zero length.
 *     Error during 'write': no writable vector found.
 *
 * after which `runSim()` never settles: the run hangs. Verified to be neither
 * device-specific (R, C and even L alone all hang) nor caused by the option's
 * bluntness — a targeted `.save @r1[i]` hangs just the same. So the option stays
 * off for `.ac` (see NetlistGenerator).
 *
 * The classic SPICE workaround instead: put a 0 V source in series with the
 * device. It changes nothing electrically, but gives the device a branch current
 * ngspice *can* report. Measured against theory on an R-C divider this is exact
 * to all printed digits, phase included.
 *
 * The rewrite is confined to `.ac`; transient/DC/op runs get their currents from
 * `savecurrents` as before and are left untouched.
 */

/** Name prefix of an inserted sense source, and of the node it introduces. */
const SENSE_PREFIX = "V__i_";
const SENSE_NODE = "__i_";

/**
 * Devices that already have a branch current in AC, so inserting a sense source
 * would only add an equation: voltage sources and the controlled sources that
 * carry one, plus inductors.
 */
const HAS_BRANCH_CURRENT = /^[vehl]/i;

/**
 * Two-terminal devices we rewrite. Deliberately a whitelist: their netlist line
 * is `NAME n1 n2 …`, so the two nodes are unambiguous. A three-terminal part has
 * no single "the current" to speak of — a transistor would need one sense source
 * per terminal and three probe names — so those are left alone rather than
 * guessed at.
 */
const TWO_TERMINAL = /^[rcd]/i;

/** The sense source for a device, e.g. `R1` → `V__i_R1`. */
export function senseSourceName(device: string): string {
  return `${SENSE_PREFIX}${device}`;
}

/**
 * The device a sense source measures, or null. The inverse of
 * {@link senseSourceName}, used to report `i(v__i_r1)` back to the user as the
 * `I(R1)` they asked for (see canonicalProbe).
 */
export function senseDeviceOf(name: string): string | null {
  const m = new RegExp(`^${SENSE_PREFIX}(.+)$`, "i").exec(name.trim());
  return m ? m[1] : null;
}

/** True for the internal node an inserted sense source introduces. */
export function isSenseNode(node: string): boolean {
  return node.toLowerCase().startsWith(SENSE_NODE);
}

/**
 * True when this component line gets a series sense source in an AC run.
 * Exported for the netlist tests, which assert the selection rather than
 * re-deriving it.
 */
export function needsCurrentSense(line: string): boolean {
  const name = line.trim().split(/\s+/)[0] ?? "";
  return !!name && TWO_TERMINAL.test(name) && !HAS_BRANCH_CURRENT.test(name);
}

/**
 * Rewrite component lines so every two-terminal device whose current ngspice
 * cannot otherwise report gets a 0 V source in series with its first terminal:
 *
 *     R1 in mid 1k   →   V__i_R1 in __i_R1 0
 *                        R1 __i_R1 mid 1k
 *
 * The device moves onto a private node; every node the user named keeps its
 * name and its other connections, so probes and net labels are unaffected. The
 * source is written first so its current is positive flowing *into* the device,
 * which is the sign a reader expects from "the current through R1".
 */
export function insertCurrentSenses(componentLines: string[]): string[] {
  const out: string[] = [];
  for (const line of componentLines) {
    const parts = line.trim().split(/\s+/);
    const [name, n1] = parts;
    if (!needsCurrentSense(line) || parts.length < 3) { out.push(line); continue; }
    const node = `${SENSE_NODE}${name}`;
    out.push(`${senseSourceName(name)} ${n1} ${node} 0`);
    out.push([name, node, ...parts.slice(2)].join(" "));
  }
  return out;
}
