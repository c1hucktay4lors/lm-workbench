import fs from "fs/promises";
import path from "path";
import os from "os";

const MEMORY_DIR = path.join(os.homedir(), ".lmstudio-mcp-memory");

export const memoryTools = [
  {
    name: "scratchpad_write",
    description:
      "Write to a scratchpad file. Use for temporary notes, planning, or working through problems. Content persists between sessions.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Scratchpad name (default: 'default')",
        },
        content: {
          type: "string",
          description: "Content to write",
        },
        append: {
          type: "boolean",
          description: "Append instead of overwrite (default: false)",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "scratchpad_read",
    description: "Read from a scratchpad file.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Scratchpad name (default: 'default')",
        },
      },
    },
  },
  {
    name: "scratchpad_list",
    description: "List all available scratchpads.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

async function ensureDir() {
  await fs.mkdir(MEMORY_DIR, { recursive: true });
}

export async function handleMemoryTool(name, args) {
  await ensureDir();

  switch (name) {
    case "scratchpad_write": {
      const padName = args.name || "default";
      const padFile = path.join(MEMORY_DIR, `scratchpad_${padName}.txt`);

      if (args.append) {
        let existing = "";
        try {
          existing = await fs.readFile(padFile, "utf-8");
        } catch {
          // File doesn't exist yet
        }
        await fs.writeFile(padFile, existing + args.content);
      } else {
        await fs.writeFile(padFile, args.content);
      }

      return {
        content: [{ type: "text", text: `Wrote to scratchpad: ${padName}` }],
      };
    }

    case "scratchpad_read": {
      const padName = args.name || "default";
      const padFile = path.join(MEMORY_DIR, `scratchpad_${padName}.txt`);

      try {
        const content = await fs.readFile(padFile, "utf-8");
        return {
          content: [{ type: "text", text: `Scratchpad [${padName}]:\n${"─".repeat(40)}\n${content}` }],
        };
      } catch {
        return {
          content: [{ type: "text", text: `Scratchpad "${padName}" is empty or doesn't exist` }],
        };
      }
    }

    case "scratchpad_list": {
      const files = await fs.readdir(MEMORY_DIR);
      const pads = files
        .filter((f) => f.startsWith("scratchpad_") && f.endsWith(".txt"))
        .map((f) => f.replace("scratchpad_", "").replace(".txt", ""));

      if (pads.length === 0) {
        return {
          content: [{ type: "text", text: "No scratchpads found" }],
        };
      }

      return {
        content: [{ type: "text", text: `Scratchpads:\n${pads.map((p) => `• ${p}`).join("\n")}` }],
      };
    }

    default:
      throw new Error(`Unknown memory tool: ${name}`);
  }
}
