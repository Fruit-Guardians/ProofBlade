# Upstream attribution

`SKILL.md` is a ProofBlade-specific adaptation of the reverse-engineering
workflow and taxonomy from `ljagiello/ctf-skills`, revision
`d6662d26b5ed3caa56f5eaf6eb887964f3747162`.

Upstream: https://github.com/ljagiello/ctf-skills

The upstream project is licensed under the MIT License. This adaptation keeps
the same license declaration in its Skill metadata. It intentionally omits the
upstream's large reference library and host-specific installation instructions:
ProofBlade loads Skills within a bounded context and routes execution through
the enabled Capability, MCP, and sandbox contracts.
