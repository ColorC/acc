import type { Registry } from "../registry/index.js";
import type { ParamDef, ToolEntry } from "../types.js";

function getJsonType(param: ParamDef) {
  const t = param.type.toLowerCase();
  if (t === "boolean") return "boolean";
  if (t === "number" || t === "int" || t === "float") return "number";
  return "string";
}

export class Exporter {
  constructor(private registry: Registry) {}

  exportOpenAI(): any[] {
    return this.registry.list().map(tool => {
      const properties: any = {};
      const required: string[] = [];

      for (const p of tool.params) {
        properties[p.name] = {
          type: getJsonType(p),
          description: p.description
        };
        if (p.defaultValue !== undefined) {
          properties[p.name].default = p.defaultValue;
        }
        if (p.required) required.push(p.name);
      }

      const safeName = `${tool.group}_${tool.command}`.replace(/[^a-zA-Z0-9_-]/g, "_");

      return {
        type: "function",
        function: {
          name: safeName,
          description: tool.description || tool.summary,
          parameters: {
            type: "object",
            properties,
            required
          }
        }
      };
    });
  }

  exportMCP(): any {
    const tools = this.registry.list().map(tool => {
      const properties: any = {};
      const required: string[] = [];

      for (const p of tool.params) {
        properties[p.name] = {
          type: getJsonType(p),
          description: p.description
        };
        if (p.defaultValue !== undefined) {
          properties[p.name].default = p.defaultValue;
        }
        if (p.required) required.push(p.name);
      }

      const safeName = `${tool.group}_${tool.command}`.replace(/[^a-zA-Z0-9_-]/g, "_");

      return {
        name: safeName,
        description: tool.description || tool.summary,
        inputSchema: {
          type: "object",
          properties,
          required
        }
      };
    });

    return { tools };
  }
}
