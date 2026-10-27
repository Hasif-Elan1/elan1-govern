"""An OpenAI Agents SDK function tool guarded by Elan1 Govern.

    pip install ./packages/sdk-python openai-agents
    export GATE_URL=http://localhost:4000 GATE_KEY=gk_your_key OPENAI_API_KEY=sk-...
    python examples/python/openai_agents.py

Put @guarded under @function_tool. guarded keeps the function's name, docstring and signature,
so the tool schema the model sees is unchanged. When the tool raises (Refused, ApprovalPending),
the Agents SDK's default error handler sends the message to the model, which then tells the user.
"""

from __future__ import annotations

import asyncio
import os

from elan1_govern import Govern, guarded

gov = Govern(os.environ.get("GATE_URL", "http://localhost:4000"), api_key=os.environ["GATE_KEY"])


async def main() -> None:
    from agents import Agent, Runner, function_tool  # imported here: an example, not a dependency

    @function_tool
    @guarded(gov, "crm.issue_refund")
    async def issue_refund(order_id: str, amount: float) -> str:
        """Refund an order.

        Args:
            order_id: The order to refund.
            amount: How much to refund, in the order's currency.
        """
        return f"refunded {amount} on {order_id}"  # your real code

    agent = Agent(
        name="Support agent",
        instructions="Help customers with refunds. If a refund is refused or waiting for approval, say so plainly.",
        tools=[issue_refund],
    )
    result = await Runner.run(agent, "Please refund 40 on order A-1001, and 900 on order A-1002.")
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
