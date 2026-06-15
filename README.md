# LibreSpice

LibreSpice is a lightweight web application inspired by LTSpice behavior for quick DC operating-point checks in the browser.

## Features

- SPICE-like netlist input
- `.op` style DC operating-point analysis
- Supported elements:
  - Resistors (`R`)
  - Independent DC voltage sources (`V`)
- Node voltage and source current output

## Run locally

Open `index.html` from the repository root in a browser and click **Run .op**.

## Example netlist

```spice
* Divider
V1 in 0 10
R1 in out 1k
R2 out 0 1k
.op
```
