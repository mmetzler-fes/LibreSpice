/**
 * 50 representative LTSpice library entries used by the regression suite
 * (Phase 3). Each item is the SPICE source plus the structural facts the parser
 * is expected to recover. The values mirror real LTSpice standard models.
 */

export interface RegressionCase {
  src: string;
  name: string;
  kind: "model" | "subckt";
  /** Expected raw type token for models. */
  type?: string;
  /** Expected pin count for subcircuits. */
  pinCount?: number;
}

export const REGRESSION_CASES: RegressionCase[] = [
  // ── Diodes ──────────────────────────────────────────────────────────────
  { src: ".model 1N4148 D(IS=2.52n RS=0.568 N=1.752 CJO=4p M=0.4 TT=20n BV=100 IBV=0.1u)", name: "1N4148", kind: "model", type: "D" },
  { src: ".model 1N4001 D(IS=14.11n N=1.984 RS=33.89m BV=50 IBV=10u CJO=25.89p M=0.44 TT=5.7u)", name: "1N4001", kind: "model", type: "D" },
  { src: ".model 1N5817 D(IS=31.7u RS=0.05 N=1.0 CJO=130p M=0.5 BV=20 IBV=1m)", name: "1N5817", kind: "model", type: "D" },
  { src: ".model 1N5819 D(IS=0.5u RS=0.05 N=1.0 CJO=150p M=0.5 BV=40)", name: "1N5819", kind: "model", type: "D" },
  { src: ".model BAT54 D(IS=2.2u RS=2.0 N=1.0 CJO=10p M=0.333 BV=30 IBV=10u)", name: "BAT54", kind: "model", type: "D" },
  { src: ".model 1N914 D(IS=2.52n RS=0.568 N=1.752 CJO=4p M=0.4 TT=20n)", name: "1N914", kind: "model", type: "D" },
  { src: ".model 1N4733A D(IS=1n RS=1.0 N=1.0 BV=5.1 IBV=49m)", name: "1N4733A", kind: "model", type: "D" },
  { src: ".model MUR860 D(IS=1u RS=0.02 N=1.5 CJO=200p M=0.5 BV=600 TT=50n)", name: "MUR860", kind: "model", type: "D" },
  { src: ".model BZX84C5V1 D(IS=1n N=1.0 BV=5.1 IBV=5m)", name: "BZX84C5V1", kind: "model", type: "D" },
  { src: ".model LED_RED D(IS=1e-20 RS=2.0 N=2.0 CJO=20p BV=5)", name: "LED_RED", kind: "model", type: "D" },

  // ── NPN BJTs ────────────────────────────────────────────────────────────
  { src: ".model 2N2222 NPN(IS=1e-14 BF=200 VAF=100 IKF=0.3 RB=10 RC=1 RE=0.5 CJE=22p CJC=8p TF=0.4n TR=50n)", name: "2N2222", kind: "model", type: "NPN" },
  { src: ".model 2N3904 NPN(IS=6.7f BF=416 VAF=74 IKF=0.06 RB=10 RC=1 CJE=4.5p CJC=3.6p TF=0.3n)", name: "2N3904", kind: "model", type: "NPN" },
  { src: ".model BC547 NPN(IS=7.0f BF=375 VAF=80 IKF=0.08 RB=10 RC=1 CJE=11p CJC=5p TF=0.4n)", name: "BC547", kind: "model", type: "NPN" },
  { src: ".model BC337 NPN(IS=1.18e-14 BF=300 VAF=50 IKF=0.4 RB=10 RC=0.6 CJE=21p CJC=10p)", name: "BC337", kind: "model", type: "NPN" },
  { src: ".model 2N5551 NPN(IS=2.5f BF=120 VAF=100 IKF=0.1 RB=10 RC=1 CJE=12p CJC=4p)", name: "2N5551", kind: "model", type: "NPN" },
  { src: ".model TIP31 NPN(IS=1e-12 BF=100 VAF=200 IKF=5 RB=1 RC=0.1 RE=0.05 CJE=500p CJC=200p)", name: "TIP31", kind: "model", type: "NPN" },
  { src: ".model 2N3055 NPN(IS=1e-11 BF=70 VAF=200 IKF=10 RB=0.5 RC=0.05 CJC=600p)", name: "2N3055", kind: "model", type: "NPN" },
  { src: ".model BC107 NPN(IS=2e-14 BF=290 VAF=80 IKF=0.1 RB=10 RC=1 CJE=10p CJC=4p)", name: "BC107", kind: "model", type: "NPN" },

  // ── PNP BJTs ────────────────────────────────────────────────────────────
  { src: ".model 2N2907 PNP(IS=1e-14 BF=200 VAF=100 IKF=0.3 RB=10 RC=1 RE=0.5 CJE=30p CJC=10p)", name: "2N2907", kind: "model", type: "PNP" },
  { src: ".model 2N3906 PNP(IS=1.0f BF=180 VAF=18.7 IKF=0.08 RB=10 RC=2.5 CJE=4.5p CJC=3.6p)", name: "2N3906", kind: "model", type: "PNP" },
  { src: ".model BC557 PNP(IS=1.0f BF=300 VAF=18 IKF=0.08 RB=10 RC=1.5 CJE=11p CJC=8p)", name: "BC557", kind: "model", type: "PNP" },
  { src: ".model BC327 PNP(IS=1.18e-14 BF=300 VAF=50 IKF=0.4 RB=10 RC=0.6 CJE=21p CJC=12p)", name: "BC327", kind: "model", type: "PNP" },
  { src: ".model TIP32 PNP(IS=1e-12 BF=100 VAF=200 IKF=5 RB=1 RC=0.1 CJE=500p CJC=200p)", name: "TIP32", kind: "model", type: "PNP" },
  { src: ".model 2N5401 PNP(IS=2.5f BF=120 VAF=100 IKF=0.1 RB=10 RC=1 CJE=12p CJC=5p)", name: "2N5401", kind: "model", type: "PNP" },

  // ── MOSFETs ─────────────────────────────────────────────────────────────
  { src: ".model IRF540 NMOS(VTO=3.5 KP=20 LAMBDA=0.01 RD=0.04 RS=0.02 CGSO=1.2n CGDO=0.3n)", name: "IRF540", kind: "model", type: "NMOS" },
  { src: ".model IRF9540 PMOS(VTO=-3.5 KP=10 LAMBDA=0.01 RD=0.1 RS=0.05 CGSO=1.5n CGDO=0.4n)", name: "IRF9540", kind: "model", type: "PMOS" },
  { src: ".model 2N7000 NMOS(VTO=2.0 KP=0.5 LAMBDA=0.02 RD=1.5 RS=0.5 CGSO=20p CGDO=5p)", name: "2N7000", kind: "model", type: "NMOS" },
  { src: ".model BSS138 NMOS(VTO=1.3 KP=0.3 LAMBDA=0.02 RD=2 RS=0.5 CGSO=20p CGDO=10p)", name: "BSS138", kind: "model", type: "NMOS" },
  { src: ".model IRFZ44 NMOS(VTO=4.0 KP=25 LAMBDA=0.008 RD=0.025 RS=0.015 CGSO=2n CGDO=0.5n)", name: "IRFZ44", kind: "model", type: "NMOS" },
  { src: ".model IRF640 VDMOS(VTO=3.7 KP=5 RD=0.15 RS=0.02 CGDO=0.5n CGSO=1n)", name: "IRF640", kind: "model", type: "VDMOS" },
  { src: ".model BS170 NMOS(VTO=2.0 KP=0.2 LAMBDA=0.02 RD=2 RS=1 CGSO=15p CGDO=5p)", name: "BS170", kind: "model", type: "NMOS" },

  // ── JFETs (mapped to unknown symbol but still registered) ────────────────
  { src: ".model J201 NJF(VTO=-0.8 BETA=0.3m LAMBDA=2m RD=10 RS=10 CGS=4p CGD=4p)", name: "J201", kind: "model", type: "NJF" },
  { src: ".model 2N5457 NJF(VTO=-1.5 BETA=1m LAMBDA=2m RD=20 RS=20 CGS=4.5p CGD=4.5p)", name: "2N5457", kind: "model", type: "NJF" },
  { src: ".model J175 PJF(VTO=-3.0 BETA=0.5m LAMBDA=2m RD=10 RS=10 CGS=5p CGD=5p)", name: "J175", kind: "model", type: "PJF" },

  // ── Passive / behavioural models ────────────────────────────────────────
  { src: ".model RTEMP RES(R=1 TC1=0.004 TC2=1e-6)", name: "RTEMP", kind: "model", type: "RES" },
  { src: ".model CMOD CAP(C=1 TC1=1e-4)", name: "CMOD", kind: "model", type: "CAP" },

  // ── Subcircuits ─────────────────────────────────────────────────────────
  { src: ".subckt LM741 1 2 3 4 5\n  R1 1 2 1MEG\n  E1 5 0 1 2 200k\n  R2 5 0 75\n.ends LM741", name: "LM741", kind: "subckt", pinCount: 5 },
  { src: ".subckt TL072 in+ in- vcc vee out\n  G1 0 n1 in+ in- 1m\n  R1 n1 0 1MEG\n  E1 out 0 n1 0 1\n.ends", name: "TL072", kind: "subckt", pinCount: 5 },
  { src: ".subckt NE555 GND TRIG OUT RST CTRL THR DIS VCC\n  R1 VCC CTRL 5k\n  R2 CTRL n1 5k\n  R3 n1 GND 5k\n.ends NE555", name: "NE555", kind: "subckt", pinCount: 8 },
  { src: ".subckt LM358 out in- in+ vcc gnd\n  G1 0 n1 in+ in- 1m\n  R1 n1 0 1MEG\n  E1 out gnd n1 0 1\n.ends LM358", name: "LM358", kind: "subckt", pinCount: 5 },
  { src: ".subckt OPAMP_IDEAL inp inn out\n  E1 out 0 inp inn 1e6\n.ends OPAMP_IDEAL", name: "OPAMP_IDEAL", kind: "subckt", pinCount: 3 },
  { src: ".subckt LDO in out gnd\n  R1 in out 0.1\n  C1 out gnd 1u\n.ends LDO", name: "LDO", kind: "subckt", pinCount: 3 },
  { src: ".subckt HBRIDGE a b vcc gnd\n  M1 a vcc vcc gnd IRF540\n  M2 a gnd gnd gnd IRF540\n.ends", name: "HBRIDGE", kind: "subckt", pinCount: 4 },
  { src: ".subckt RELAY coil1 coil2 com no\n  L1 coil1 coil2 100m\n  R1 coil1 coil2 200\n.ends RELAY", name: "RELAY", kind: "subckt", pinCount: 4 },
  { src: ".subckt XTAL p1 p2\n  L1 p1 n1 10m\n  C1 n1 p2 20f\n  C2 p1 p2 5p\n.ends", name: "XTAL", kind: "subckt", pinCount: 2 },
  { src: ".subckt OPTO anode cathode collector emitter\n  D1 anode cathode LED_RED\n  Q1 collector emitter emitter 2N3904\n.ends OPTO", name: "OPTO", kind: "subckt", pinCount: 4 },

  // ── Multi-line (continuation) entries to exercise the `+` folding ─────────
  { src: ".model BIGNPN NPN(IS=1e-14 BF=200\n+ VAF=100 IKF=0.3 RB=10\n+ RC=1 RE=0.5 CJE=22p CJC=8p)", name: "BIGNPN", kind: "model", type: "NPN" },
  { src: ".subckt BUFFER in out vdd vss\n+  M1 out in vdd vdd IRF9540\n+  M2 out in vss vss IRF540\n.ends BUFFER", name: "BUFFER", kind: "subckt", pinCount: 4 },
  { src: ".model SCHOTTKY D(IS=1u RS=0.02 N=1.0 ; inline comment\n+ CJO=100p M=0.5 BV=40)", name: "SCHOTTKY", kind: "model", type: "D" },
  { src: "* Power diode definition\n.model PWRDIODE D(IS=5u RS=0.01 N=1.6 BV=1000 TT=100n CJO=300p)", name: "PWRDIODE", kind: "model", type: "D" },
];
