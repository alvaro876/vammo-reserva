# RIVERS — os conceitos e o porquê

Este texto não tem número, tabela nem métrica. É só pra você entender, de verdade, como o RIVERS pensa e por que cada escolha foi feita do jeito que foi. Se em algum momento você conseguir explicar isso pra outra pessoa sem olhar o papel, o texto cumpriu o objetivo.

---

## O problema que existe antes do RIVERS

Quando um cliente deixa a moto na oficina, ele fica sem trabalhar. Se o conserto é rápido, ele espera e leva a moto de volta. Mas se o conserto vai demorar, deixar o cliente esperando parado é ruim pra todo mundo — ele perde o dia, reclama, e a Vammo perde confiança. Pra isso existe a moto reserva: um empréstimo enquanto a dele não fica pronta.

A pergunta então é simples de enunciar e difícil de responder na hora certa: **essa moto vai demorar a ponto de valer a pena dar uma reserva?** A régua da empresa é o tempo — se não fica pronta em três horas, dá reserva.

O problema é que, antes do RIVERS, quem respondia isso era uma pessoa. O líder de turno olhava as ordens de serviço, no meio de mil outras tarefas, e decidia no feeling. Isso trazia três dores. A decisão dependia de quem estava de plantão — cada um com um critério na cabeça. Ela saía tarde, muitas vezes só quando o cliente já tinha esperado demais e reclamado. E ninguém conseguia explicar depois por que aquela moto ganhou reserva e a outra não.

## A ideia central do RIVERS

O RIVERS troca uma coisa por outra: em vez de **reagir** quando o problema já apareceu, ele **antecipa**. A ideia é olhar toda moto que entra em manutenção, o tempo todo, e decidir cedo — logo depois do diagnóstico — se ela vai estourar as três horas. E, junto com a decisão, sempre dizer o porquê, em português, pra qualquer pessoa entender e discordar se quiser.

Antecipar e explicar. Esses são os dois compromissos que definem tudo o que vem depois.

## Por que regras, e não uma "inteligência artificial"

Essa foi uma escolha consciente, e vale entender o motivo. Seria possível jogar um monte de dado num modelo de aprendizado de máquina e deixar ele "adivinhar" quem precisa de reserva. Mas aí a decisão viraria uma caixa-preta: o sistema diz "reserva" e ninguém sabe por quê.

Numa operação, isso não cola. O líder da oficina precisa poder olhar a decisão e falar "isso está errado, e é por isso". Ele precisa confiar, e confiança vem de entender. Por isso o RIVERS é um conjunto de **regras claras** — cada uma com uma lógica que dá pra explicar em uma frase. A "inteligência" dele não está em adivinhar; está em fazer contas boas com informação confiável.

Isso não quer dizer que não usamos dado ou estatística — usamos, e muito. Mas usamos pra **alimentar** as regras com bons números, não pra substituir o raciocínio por um palpite opaco.

## Tudo se resume a uma pergunta

No fundo, todas as regras do RIVERS respondem à mesma pergunta: **essa moto fica pronta em três horas?** E existem basicamente dois jeitos de a resposta ser "não".

O primeiro é o **tempo**: o serviço em si é longo, ou tem tanta moto na frente que a vez dela não chega a tempo, ou ela está parada há horas sem ninguém nem começar a olhar. Tudo isso é uma variação de "vai demorar demais".

O segundo é a **peça**: o conserto depende de uma peça que não tem na base. Aqui nem importa o tempo — sem a peça, não fica pronta hoje, ponto.

E existem os casos óbvios, que nem precisam de conta: moto que chegou de guincho, de acidente, ou que não anda. Esses ganham reserva na hora, porque a situação já diz tudo.

Se você entendeu isso — tempo, peça, e os casos óbvios — você entendeu o coração do RIVERS. Todo o resto é detalhe de como calcular bem cada uma dessas coisas.

## Por que precisamos estimar o tempo — e por que foi difícil

Pra responder "vai demorar demais?", o RIVERS precisa saber quanto tempo o serviço leva. Parece que bastaria olhar um cadastro: cada peça tem um tempo previsto, soma tudo, pronto. O problema é que esse cadastro estava furado — muita peça com tempo zerado ou errado. Confiar nele era construir a decisão em cima de areia.

A saída foi parar de perguntar pro cadastro e começar a perguntar pra **história**. A oficina já consertou milhares de motos; esses consertos deixaram rastro de quanto tempo cada um levou de verdade. A ideia foi olhar esse histórico todo e deixar os próprios dados dizerem: "toda vez que trocaram esta peça, o serviço levou mais ou menos tanto".

O conceito por trás disso é o de aprender um padrão a partir de exemplos. Você não decreta o tempo de cada peça — você deixa o comportamento real de milhares de casos revelar esse tempo. E some a isso um "custo fixo" que toda moto tem, independente da peça: o tempo de receber, mexer, testar e fechar. No fim, a estimativa de uma moto vira o custo fixo mais o tempo aprendido de cada peça que ela precisa.

Isso é infinitamente mais confiável do que um cadastro que ninguém manteve.

## Por que essa estimativa às vezes exagera

Vale entender uma limitação, porque ela é honesta e explica um comportamento real. A conta soma o tempo de cada peça, uma por uma. Mas um mecânico não trabalha assim: quando ele abre a moto pra trocar a caixa de direção, ele aproveita e mexe no freio e na roda que estão ali do lado, tudo na mesma desmontagem. Ou seja, várias coisas acontecem **em paralelo**, e a soma trata como se fossem **em sequência**.

O resultado é que, numa moto com muitas peças, a estimativa fica mais alta do que o tempo real. É uma superestimação conhecida, e o ajuste é justamente ensinar a conta a "dar desconto" quando há muita peça junta. O importante aqui não é o número — é entender que a natureza aditiva da conta é a causa, e que isso é corrigível.

## O modelo da oficina — a parte que você perguntou

Essa é a parte mais interessante, e a que gera mais confusão, então vou com calma.

Estimar o tempo do serviço não basta. Imagine um serviço rapidinho, de meia hora. Ele deveria ficar pronto fácil dentro das três horas, certo? Mas e se tiver quinze motos na frente e só dois mecânicos trabalhando? Aí aquela meia hora de serviço só começa a ser feita daqui a duas horas e meia. A moto estoura o prazo não por causa do serviço dela, mas por causa da **fila**.

Então o RIVERS precisa entender a oficina como um sistema com capacidade limitada. De um lado, a demanda: quantas motos estão esperando e quanto trabalho elas representam. Do outro, a capacidade: quantos mecânicos estão de fato trabalhando naquela base, naquela hora. A fila que uma moto vai pegar depende dessa relação entre o quanto tem pra fazer e o quantos estão fazendo.

Esse é o conceito central do modelo de oficina: **capacidade contra demanda**. Uma oficina cheia com muita gente escalada engole a fila rápido; uma oficina cheia com pouca gente trava.

### Como a fila entra na conta

Antes de falar do modelo em si, vale entender como capacidade e demanda viram um tempo de espera. A intuição vem da **teoria de filas**: se você sabe quanto trabalho está acumulado esperando (a soma dos tempos estimados das motos na fila) e sabe o ritmo com que a oficina dá conta desse trabalho (quantos mecânicos estão produzindo em paralelo), o tempo que uma moto nova vai esperar é, grosso modo, o trabalho acumulado dividido pelo ritmo de atendimento. Muita fila com pouca gente produzindo dá uma espera longa; pouca fila com muita gente, uma espera curta. O modelo de capacidade existe pra estimar bem esse "ritmo de atendimento" — o denominador dessa divisão.

### Que modelo é esse, afinal

Aqui teve uma decisão que vale a pena entender, porque mostra como pensamos — e é onde entra o método estatístico de verdade.

Precisávamos de um número: quantos mecânicos estão de fato produzindo naquela base, naquela hora. Testamos dois modelos para prever isso.

**Modelo 1 — a média condicional do histórico.** Esse é o mais estatístico dos dois, e conceitualmente é o que se chama de *baseline sazonal* (ou, numa analogia com meteorologia, um modelo de "climatologia"): você não tenta modelar causas, você simplesmente aprende o padrão que se repete. A ideia é olhar o histórico recente e calcular a **média de mecânicos realmente ativos, condicionada a três coisas: a base, o dia da semana e a hora do dia**. "Condicionada" quer dizer que não é uma média geral — é uma média separada pra cada combinação. A previsão para uma terça às 14h na Mooca é a média do que aconteceu nas outras terças às 14h na Mooca.

Por que separar por dia da semana e por hora? Porque o movimento da oficina tem **sazonalidade** — ele se repete em ciclos previsíveis. Segunda de manhã não se parece com sábado à tarde; o meio-dia tem o vale do almoço todo dia. Um modelo que joga tudo numa média só apaga esses padrões; um que condiciona por dia e hora os preserva. É um método simples, não-paramétrico (não assume nenhuma fórmula por trás), e justamente por ser guiado pelos dados ele captura naturalmente coisas como o almoço e a troca de turno, sem a gente precisar programar isso.

**Modelo 2 — a escala corrigida.** O segundo jeito parte da **escala** do sistema de ponto (quem está marcado pra trabalhar no turno) e aplica um **fator de correção** aprendido do histórico. Esse fator existe porque "estar escalado" não é o mesmo que "estar na rampa produzindo" — sempre tem uma fração em almoço, reunião, outra tarefa. Então a gente mede, no histórico, qual a proporção típica entre quem estava escalado e quem estava de fato produzindo, e usa essa proporção pra "descontar" a escala. É um modelo mais simples e mais direto, mas depende da qualidade da escala.

**Como decidimos qual usar.** Comparamos os dois de um jeito honesto: para cada dia, previmos a capacidade hora a hora e olhamos o **tamanho típico do erro** contra o que realmente aconteceu — o erro médio absoluto, ou seja, na média, de quantos mecânicos cada modelo errava por hora. E aqui veio a surpresa: a **média condicional (Modelo 1) errava menos** que a escala corrigida. Faz sentido — a escala diz quem bateu ponto, não quem está na rampa; a média do que de fato aconteceu já embute todas as perdas do mundo real.

### Por que, mesmo assim, usamos a escala no RIVERS

Essa é a parte contra-intuitiva. O modelo estatístico ganhou na precisão, mas o RIVERS **usa a escala**. O motivo é conceitual, não estatístico: o quadro de mecânicos da Vammo está crescendo rápido. Uma média do passado sempre olha pra trás — ela é boa em capturar o padrão *que existia*, mas fica atrasada quando a realidade muda de patamar. Se a base contratou gente esse mês, a média histórica ainda "acha" que tem menos gente do que tem hoje. A escala, por mais imperfeita que seja, reflete o presente — e é a informação que a própria operação controla e ajusta todo dia.

Ou seja: escolhemos a medida menos precisa **na média** porque ela é mais fiel ao **agora**. É uma troca clássica entre um modelo que erra menos em regime estável e um que acompanha melhor as mudanças. Num negócio que cresce rápido, acompanhar a mudança vale mais.

E anotamos o preço dessa escolha, porque ele aparece: numa semana em que a escala encolhe — um feriado, por exemplo — o modelo pode achar que a oficina está mais travada do que realmente está, e sugerir reserva demais. É um efeito colateral conhecido, e é exatamente o tipo de coisa que a tela de capacidade serve pra flagrar.

### A tela de capacidade — por que ela existe

Você perguntou daquela tela, a `/capacidade`. Ela é o **espelho** do modelo de oficina. A ideia dela é simples: pra cada hora do dia, mostrar lado a lado o que o modelo **previu** de mecânicos e o que **de fato** aconteceu. Assim qualquer pessoa consegue olhar e julgar sozinha se a previsão está batendo com a realidade, sem precisar acreditar na nossa palavra.

O conceito por trás dela é o de manter o modelo honesto. Um modelo que ninguém confere vira fé. Um modelo que fica exposto ao lado da realidade, todo dia, se mantém sob checagem — e quando ele começa a errar, você vê na hora. É uma ferramenta de transparência tanto quanto de acompanhamento.

Um detalhe de honestidade que vale entender, e que tem nome: **validação cruzada deixando um de fora** (em inglês, *leave-one-out*). Pra avaliar a previsão de um dia, a tela nunca usa esse mesmo dia no cálculo — senão seria trapaça, o modelo estaria "prevendo" algo que ele já viu. Ele prevê o dia com base só nos outros dias parecidos, e só depois compara com o que aconteceu de verdade naquele dia. É a mesma lógica de estudar pra prova com exercícios diferentes dos que vão cair: se você treina no próprio gabarito, acertar não prova nada. Esse cuidado é o que faz o "acerto" mostrado na tela ser real, e não uma ilusão de quem se testa em cima da própria resposta.

## Por que medimos tudo contra a realidade

Um sistema que decide sozinho precisa provar que decide bem. E "provar" aqui não é opinião — é confrontar cada decisão do RIVERS com dois fatos: o que a oficina de fato fez, e o que aconteceu com a moto no fim das contas. A moto realmente demorou? Então quem mandou reservar estava certo. A moto ficou pronta rapidinho? Então foi exagero.

Teve um aprendizado importante sobre o que medir. No começo, medíamos o tempo até o cliente vir buscar a moto. Só que isso enganava: um cliente que está com uma reserva na mão não tem pressa nenhuma de devolver e buscar a dele. A moto ficava pronta rápido, mas parada esperando o dono aparecer — e a conta parecia dizer que o conserto demorou horrores. Trocamos a régua pra medir o que importa de verdade: o tempo até a moto **ficar pronta**, não até ser retirada. Esse tipo de correção é o que faz a medição ser confiável.

## Por que o RIVERS "só funciona quando alguém abre"

Um último conceito, que ajuda a entender a pendência mais importante. O RIVERS não é um robô que fica acordado sozinho o tempo todo. Ele é mais como uma calculadora muito boa: ele responde quando alguém faz a pergunta. Quem faz a pergunta hoje é a tela aberta ou o sistema da mesa consultando ele. Se ninguém pergunta — de madrugada, no fim de semana — ele fica quieto, não porque não sabe responder, mas porque ninguém perguntou.

Por isso a peça que falta é um "despertador": algo que faça a pergunta pra ele de tempos em tempos, sozinho, sem depender de ninguém estar com a tela aberta. Isso é o que vai fazer ele funcionar de verdade vinte e quatro horas por dia. E é um ponto importante de entender: o que falta não é inteligência, é **presença**. Ele já sabe decidir bem; só precisa estar sempre ligado pra decidir.

---

## Se você levar só uma coisa

O RIVERS é um sistema que antecipa e explica uma decisão que antes era manual e tardia. Ele reduz tudo a uma pergunta — "fica pronta em três horas?" — e responde com regras claras, alimentadas por bons números que a gente aprendeu do histórico em vez de confiar em cadastro furado. Pra responder bem, ele entende a oficina como capacidade contra demanda. E cada escolha que fizemos — usar regras, aprender o tempo dos dados, usar a escala mesmo perdendo em precisão, medir até ficar pronta — teve o mesmo norte: uma decisão em que a operação consegue confiar, porque consegue entender.
