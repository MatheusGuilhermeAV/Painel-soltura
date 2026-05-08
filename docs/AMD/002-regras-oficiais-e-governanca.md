# Regras oficiais e governança de mudanças

## Regras permanentes (SSOV)

1. **O mapa sempre domina** — é o ambiente operacional principal; nada pode roubar foco estrutural.
2. **Nada compete com a operação** — relatórios e administração ficam em módulos secundários.
3. **Alertas imediatamente reconhecíveis** — cor, rótulo operacional forte, hierarquia; animação só com ADR.
4. **Toda informação deve ser operacionalmente útil** — teste: «Isso melhora decisão ou leitura?»
5. **Identidade Eucatur respeitada** — camada institucional (tokens) + camada operacional (SSOV); não confundir com site marketing.
6. **Institucional e robusto** — contraste, painéis sólidos, linguagem de console.
7. **Operador experiente rápido** — atalhos, menu estável (memória muscular).
8. **Usuário novo aprende rápido** — rótulos claros e hierarquia explícita.

## Pergunta para qualquer feature nova

1. Isso melhora a tomada de decisão?  
2. Isso melhora a leitura operacional?  
3. Isso respeita a identidade institucional (duas camadas)?  
4. Isso mantém o mapa soberano?

Se alguma resposta for «não», a feature não entra na área principal sem redesign.

## Governança

- Alterações listadas em [004-areas-protegidas-sem-adr.md](004-areas-protegidas-sem-adr.md) exigem **ADR** antes do merge.
- Alteração de tokens de cor exige atualização simultânea de:
  - [003-tokens-cor-e-estados.md](003-tokens-cor-e-estados.md)
  - `static/css/dashboard.css` (`:root` SSOV/Eucatur)
  - `services/status.py` (`classify_vehicle_status` — valores `mapa_cor`)

## Topo e menu

- **Topo**: baixo peso visual, alta informação (atualização, API, usuário, modo).  
- **Menu lateral**: ordem fixa; mudança de itens só com ADR.
