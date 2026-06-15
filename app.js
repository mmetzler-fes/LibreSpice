(function () {
  const UNIT_MULTIPLIERS = {
    t: 1e12,
    g: 1e9,
    meg: 1e6,
    k: 1e3,
    m: 1e-3,
    u: 1e-6,
    n: 1e-9,
    p: 1e-12,
    f: 1e-15,
  };

  function normalizeNode(node) {
    const value = String(node || "").trim().toLowerCase();
    return value === "gnd" ? "0" : value;
  }

  function parseValue(rawValue) {
    if (!rawValue) {
      throw new Error("Missing component value.");
    }

    const text = String(rawValue).trim();
    const match = text.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)([a-zA-Z]+)?$/);
    if (!match) {
      throw new Error(`Invalid numeric value: ${rawValue}`);
    }

    const base = Number(match[1]);
    const suffix = (match[2] || "").toLowerCase();

    if (!suffix) {
      return base;
    }

    if (!(suffix in UNIT_MULTIPLIERS)) {
      throw new Error(`Unsupported unit suffix: ${suffix}`);
    }

    return base * UNIT_MULTIPLIERS[suffix];
  }

  function parseNetlist(netlist) {
    const elements = [];
    const lines = String(netlist)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("*"));

    for (const line of lines) {
      if (line.startsWith(".")) {
        continue;
      }

      const tokens = line.split(/\s+/);
      if (tokens.length < 4) {
        throw new Error(`Invalid statement: ${line}`);
      }

      const name = tokens[0];
      const type = name[0]?.toUpperCase();

      if (type !== "R" && type !== "V") {
        throw new Error(`Unsupported element type '${name[0]}' in: ${line}`);
      }

      elements.push({
        name,
        type,
        nodeA: normalizeNode(tokens[1]),
        nodeB: normalizeNode(tokens[2]),
        value: parseValue(tokens[3]),
      });
    }

    if (elements.length === 0) {
      throw new Error("No circuit elements found.");
    }

    return elements;
  }

  function solveLinearSystem(matrix, vector) {
    const n = vector.length;
    const a = matrix.map((row) => row.slice());
    const b = vector.slice();

    for (let col = 0; col < n; col += 1) {
      let pivot = col;
      for (let row = col + 1; row < n; row += 1) {
        if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) {
          pivot = row;
        }
      }

      if (Math.abs(a[pivot][col]) < 1e-12) {
        throw new Error("Circuit matrix is singular. Check connectivity and references.");
      }

      if (pivot !== col) {
        [a[col], a[pivot]] = [a[pivot], a[col]];
        [b[col], b[pivot]] = [b[pivot], b[col]];
      }

      const pivotValue = a[col][col];
      for (let c = col; c < n; c += 1) {
        a[col][c] /= pivotValue;
      }
      b[col] /= pivotValue;

      for (let row = 0; row < n; row += 1) {
        if (row === col) {
          continue;
        }

        const factor = a[row][col];
        if (factor === 0) {
          continue;
        }

        for (let c = col; c < n; c += 1) {
          a[row][c] -= factor * a[col][c];
        }
        b[row] -= factor * b[col];
      }
    }

    return b;
  }

  function solveDcOperatingPoint(elements) {
    const nodeSet = new Set();
    const voltageSources = [];

    for (const element of elements) {
      if (element.nodeA !== "0") {
        nodeSet.add(element.nodeA);
      }
      if (element.nodeB !== "0") {
        nodeSet.add(element.nodeB);
      }
      if (element.type === "V") {
        voltageSources.push(element);
      }
    }

    const nodes = Array.from(nodeSet);
    const nodeIndex = new Map(nodes.map((node, index) => [node, index]));
    const dimension = nodes.length + voltageSources.length;

    if (dimension === 0) {
      throw new Error("No unknowns to solve.");
    }

    const matrix = Array.from({ length: dimension }, () => Array(dimension).fill(0));
    const vector = Array(dimension).fill(0);

    function maybeIndex(node) {
      if (node === "0") {
        return null;
      }
      return nodeIndex.get(node);
    }

    for (const element of elements) {
      if (element.type === "R") {
        if (element.value === 0) {
          throw new Error(`${element.name} has zero resistance.`);
        }

        const conductance = 1 / element.value;
        const a = maybeIndex(element.nodeA);
        const b = maybeIndex(element.nodeB);

        if (a !== null) {
          matrix[a][a] += conductance;
        }
        if (b !== null) {
          matrix[b][b] += conductance;
        }
        if (a !== null && b !== null) {
          matrix[a][b] -= conductance;
          matrix[b][a] -= conductance;
        }
      }
    }

    voltageSources.forEach((source, sourcePosition) => {
      const row = nodes.length + sourcePosition;
      const a = maybeIndex(source.nodeA);
      const b = maybeIndex(source.nodeB);

      if (a !== null) {
        matrix[a][row] += 1;
        matrix[row][a] += 1;
      }
      if (b !== null) {
        matrix[b][row] -= 1;
        matrix[row][b] -= 1;
      }

      vector[row] = source.value;
    });

    const solution = solveLinearSystem(matrix, vector);

    const nodeVoltages = { "0": 0 };
    nodes.forEach((node, index) => {
      nodeVoltages[node] = solution[index];
    });

    const sourceCurrents = {};
    voltageSources.forEach((source, sourcePosition) => {
      sourceCurrents[source.name] = solution[nodes.length + sourcePosition];
    });

    return { nodeVoltages, sourceCurrents };
  }

  function formatResults(result) {
    const voltages = Object.entries(result.nodeVoltages)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([node, value]) => `V(${node}) = ${value.toFixed(6)} V`);

    const currents = Object.entries(result.sourceCurrents)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `I(${name}) = ${value.toFixed(6)} A`);

    return [...voltages, ...(currents.length ? ["", ...currents] : [])].join("\n");
  }

  function runSimulation(netlistText) {
    const elements = parseNetlist(netlistText);
    const result = solveDcOperatingPoint(elements);
    return formatResults(result);
  }

  if (typeof document !== "undefined") {
    const textarea = document.getElementById("netlist");
    const button = document.getElementById("simulate");
    const result = document.getElementById("result");

    button?.addEventListener("click", () => {
      try {
        result.textContent = runSimulation(textarea?.value || "");
      } catch (error) {
        result.textContent = `Error: ${error.message}`;
      }
    });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      parseNetlist,
      solveDcOperatingPoint,
      runSimulation,
      parseValue,
    };
  }
})();
