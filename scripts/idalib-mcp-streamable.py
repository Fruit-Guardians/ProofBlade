"""Run IDA Pro MCP against one input using ProofBlade's Streamable HTTP contract.

The upstream ida-pro-mcp launcher currently exposes SSE and requires a single
input path. ProofBlade uses Streamable HTTP, so this small adapter keeps the
upstream tool implementation while making the transport and endpoint explicit.
"""

from __future__ import annotations

import argparse
import importlib
import inspect
import logging
from pathlib import Path

import typing_inspection.introspection as intro

from mcp.server.fastmcp import FastMCP

import idapro
import ida_auto
import ida_hexrays


def fixup_tool_argument_descriptions(mcp: FastMCP) -> None:
    """Copy Annotated parameter descriptions into FastMCP schemas."""
    for tool in mcp._tool_manager.list_tools():
        for name, parameter in inspect.signature(tool.fn).parameters.items():
            if not parameter.annotation:
                continue
            annotation = intro.inspect_annotation(
                parameter.annotation,
                annotation_source=intro.AnnotationSource.ANY,
            )
            if annotation.type is str and len(annotation.metadata) == 1:
                description = annotation.metadata[0]
                if isinstance(description, str):
                    tool.parameters["properties"][name]["description"] = description


def main() -> None:
    parser = argparse.ArgumentParser(description="ProofBlade Streamable HTTP IDA MCP server")
    parser.add_argument("input_path", type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18745)
    parser.add_argument("--verbose", "-v", action="store_true")
    parser.add_argument("--unsafe", action="store_true")
    args = parser.parse_args()

    if not args.input_path.is_file():
        raise FileNotFoundError(f"Input file not found: {args.input_path}")

    level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=level)
    idapro.enable_console_messages(args.verbose)

    logging.info("opening database: %s", args.input_path)
    if idapro.open_database(str(args.input_path), run_auto_analysis=True):
        raise RuntimeError("failed to analyze input file")
    ida_auto.auto_wait()
    if not ida_hexrays.init_hexrays_plugin():
        raise RuntimeError("failed to initialize Hex-Rays decompiler")

    upstream = importlib.import_module("ida_pro_mcp.idalib_server")
    mcp: FastMCP = upstream.mcp
    plugin = importlib.import_module("ida_pro_mcp.mcp-plugin")
    for name, callable in plugin.rpc_registry.methods.items():
        if args.unsafe or name not in plugin.rpc_registry.unsafe:
            mcp.add_tool(callable, name)
    fixup_tool_argument_descriptions(mcp)
    mcp.settings.host = args.host
    mcp.settings.port = args.port
    logging.info("ProofBlade IDALIB-MCP available at http://%s:%d/mcp", args.host, args.port)
    mcp.run(transport="streamable-http", mount_path="/mcp")


if __name__ == "__main__":
    main()
