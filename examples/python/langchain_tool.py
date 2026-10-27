"""A LangChain tool guarded by Elan1 Govern.

    pip install ./packages/sdk-python langchain-core
    export GATE_URL=http://localhost:4000 GATE_KEY=gk_your_key
    python examples/python/langchain_tool.py

`governed()` takes any LangChain StructuredTool (from @tool or StructuredTool.from_function) and
returns one that asks Elan1 Govern first. A refusal or a pending approval reaches the model as the
tool's error text, so it can tell the user instead of crashing the agent.
"""

from __future__ import annotations

import os
from typing import Any

from elan1_govern import ApprovalPending, Govern, Refused, guarded


def governed(lc_tool: Any, gov: Govern, govern_tool: str, wait: bool = False) -> Any:
    from langchain_core.tools import StructuredTool, ToolException  # imported here: an example, not a dependency

    run = guarded(gov, govern_tool, wait=wait)(lc_tool.func)

    def call(**kwargs: Any) -> Any:
        try:
            return run(**kwargs)
        except Refused as e:
            raise ToolException(f"Refused by rule {e.rule_id}: {e.reason}") from e
        except ApprovalPending as e:
            raise ToolException(f"Waiting for a person to approve at {e.approval_url}. Do not retry.") from e

    return StructuredTool.from_function(
        func=call,
        name=lc_tool.name,
        description=lc_tool.description,
        args_schema=lc_tool.args_schema,
        handle_tool_error=True,
    )


def main() -> None:
    from langchain_core.tools import tool

    @tool
    def issue_refund(order_id: str, amount: float) -> str:
        """Refund an order. Amount is in the order's currency."""
        return f"refunded {amount} on {order_id}"  # your real code

    gov = Govern(os.environ.get("GATE_URL", "http://localhost:4000"), api_key=os.environ["GATE_KEY"])
    safe_refund = governed(issue_refund, gov, "crm.issue_refund")

    print(safe_refund.invoke({"order_id": "A-1001", "amount": 40}))
    print(safe_refund.invoke({"order_id": "A-1002", "amount": 900}))
    # In an agent: model.bind_tools([safe_refund]), or pass tools=[safe_refund] to your agent builder.


if __name__ == "__main__":
    main()
