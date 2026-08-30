import { BUILTIN_TOOLS } from "../tools";
import { ResearchTool } from "./tool";

const registry = BUILTIN_TOOLS as unknown as Record<string, (session: import("../tools").ToolSession) => unknown>;
if (!registry.research) registry.research = session => new ResearchTool(session) as never;
