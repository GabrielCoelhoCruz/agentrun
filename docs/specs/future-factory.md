# Factory e visão por nós

Status: proposta futura. Não faz parte da v1. Nenhuma funcionalidade deste documento está implementada.

## Objetivo

Usar o agentrun para executar etapas de uma mudança e mostrar o trabalho em uma visão por nós. Um nó representa uma etapa. Uma conexão mostra qual resultado a próxima etapa precisa receber.

O usuário escreve o objetivo, acompanha o trabalho, consulta a evidência e aprova o commit exato antes da entrega. O core continua como executor. A coordenação das etapas fica em um pacote privado separado, com localização proposta em `packages/factory`.

## Ordem de entrega

1. Concluir a v1 atual.
2. Preparar os contratos necessários: identificação da execução desde o início, falhas estruturadas e perfil de ferramentas para revisão.
3. Implementar um fluxo sequencial com estado persistido e limites de correção.
4. Mostrar esse fluxo em uma interface local por nós, inicialmente para consulta.
5. Acrescentar controles usando as mesmas operações da CLI.
6. Avaliar planejamento e triagem, depois integrações externas.

## Primeiro fluxo

Tarefa escrita pelo usuário → implementação → verificações → revisão independente → aprovação humana → exportação local.

Falha de verificação ou pedido de mudança abre uma correção. A nova versão passa novamente pelas verificações e pela revisão. Proposta inicial: até dois ciclos automáticos. Após o limite, o fluxo pede uma decisão humana.

Cada etapa consome a identidade do commit entregue. Uma branch pode mudar e não serve como identidade. A aprovação contém o commit e os hashes do patch e da evidência. Uma nova versão invalida a aprovação anterior.

## Visão por nós

Exibir o fluxo executado, incluindo ciclos de correção. Não começar com um editor de fluxos arbitrários.

Cada nó mostra:

- tipo da etapa e identificador;
- estado: aguardando, em execução, concluído, falhou, interrompido ou aguardando decisão;
- duração e custo informado, com indicação quando o custo está indisponível;
- agente usado, quando a etapa usa um agente;
- commit de entrada e de saída;
- dependências e motivo de bloqueio.

Ao selecionar um nó, abrir os logs, o diff, o resultado das verificações e a revisão. A visão geral mostra quais etapas trabalham, quais esperam uma entrada e quais precisam do usuário. Usar texto e ícones, além de cor. Disponibilizar uma lista acessível como alternativa ao grafo.

## Controles futuros

| Controle | Comportamento |
|---|---|
| Cancelar execução | Interromper o trabalho, salvar estado e executar cleanup conforme o contrato do executor. |
| Retomar | Reconciliar o estado e continuar o trabalho autorizado. Não lançar uma execução duplicada. |
| Pedir correção | Registrar a instrução e criar uma nova versão do candidato. |
| Aprovar | Exigir a identidade exata do candidato e da evidência mostrados. |
| Exportar | Conferir novamente a aprovação e entregar patch, commit e evidência. |

Não prometer pausa de um processo em execução. Uma futura função de pausa deve parar antes da próxima etapa e mostrar essa diferença.

## Contrato entre interface e execução

A interface consulta o estado persistido e recebe eventos identificados. Ela pode recuperar a sequência após desconexão. Fechar a aba não cancela uma execução. A operação que controla a execução mantém responsabilidade pelo processo e pelo cleanup.

A interface usa as mesmas operações da CLI. Não cria uma segunda implementação das regras. Comandos de alteração incluem a versão esperada do item; estado desatualizado causa recusa e atualização da tela. A aprovação exige confirmação da identidade atual no backend.

Primeira interface: local, para um usuário. Endereço de rede, autenticação, transporte de eventos e biblioteca visual serão definidos na etapa de implementação. Logs, prompts e diffs podem conter dados privados; não expor a interface publicamente por padrão.

## Limites

- Um processo concluído não prova qualidade aceita.
- Revisão por agente é opinião; verificações produzem evidência separada.
- Diff vazio não garante um revisor sem escrita.
- Worktrees não são sandbox. Agentes que compartilham usuário e filesystem não estão isolados da autoridade de aprovação.
- Tarefas da v1 são independentes. Etapas dependentes precisam de coordenação explícita.
- Paralelismo entre itens, conflitos e integração de mudanças serão entregas posteriores.
- Publicação npm permanece fora do plano atual.

## Critérios de aceitação futuros

Antes da implementação, escrever casos de falha e depois os testes correspondentes.

Para o fluxo: provar passagem do commit correto, falha de verificações, revisão inválida, limite de correções, orçamento, cancelamento, retomada após queda e recusa de aprovação desatualizada.

Para a interface: provar em E2E atualização dos nós, abertura dos detalhes, recuperação após desconexão, estado após reinício, cancelamento, retomada e recusa de comandos enviados a uma versão antiga. Inspecionar os estados renderizados e a alternativa por lista.

Cada execução E2E registra branch, commit, comandos e artefatos. Provas com provedor roteirizado demonstram o fluxo; uma prova com agente real demonstra a integração com esse provedor. Distinguir os dois resultados.

## Fora das primeiras entregas

Editor visual por arrastar nós, motor genérico de grafos, Slack, Linear, merge automático, deploy automático e monitoramento que cria tarefas.

Referência de fluxo: [diagrama publicado por Ben Holmes](https://x.com/BHolmesDev/status/2106510336413012463). O desenho inspira as etapas; este documento não presume detalhes da implementação dele.
