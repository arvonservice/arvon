// Genere le recapitulatif Word du tracking de performance.
//   node tools/build-recap-docx.js
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle, LevelFormat,
} = require('docx');

const OUT = path.join(__dirname, '..', 'Arvon-recap-tracking-performance.docx');
const MONO = 'Consolas';
const ACCENT = '1A1A1A';
const GREY = 'F2F2F2';

const p = (text, o = {}) =>
  new Paragraph({
    spacing: { after: o.after ?? 140, line: 276 },
    alignment: o.align,
    children: [new TextRun({ text, bold: o.bold, italics: o.italics, size: o.size ?? 21, color: o.color, font: o.font })],
  });

const h1 = (text) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 180 },
    children: [new TextRun({ text, bold: true, size: 30, color: ACCENT })],
  });

const h2 = (text) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 260, after: 120 },
    children: [new TextRun({ text, bold: true, size: 24, color: ACCENT })],
  });

// Bloc de code : police fixe, fond gris, une ligne = un paragraphe.
const code = (lines) =>
  lines.map((l, i) =>
    new Paragraph({
      spacing: { before: i === 0 ? 100 : 0, after: i === lines.length - 1 ? 160 : 0, line: 240 },
      shading: { type: ShadingType.CLEAR, fill: GREY },
      indent: { left: 200, right: 200 },
      children: [new TextRun({ text: l || ' ', font: MONO, size: 17 })],
    })
  );

const quote = (text) =>
  new Paragraph({
    spacing: { before: 160, after: 200, line: 276 },
    indent: { left: 340 },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: ACCENT, space: 14 } },
    children: [new TextRun({ text, italics: true, size: 22 })],
  });

const bullets = (items) =>
  items.map((t) => new Paragraph({ text: t, numbering: { reference: 'puces', level: 0 }, spacing: { after: 90 } }));

// Tableau : largeurs en DXA sur la table ET sur chaque cellule.
function table(headers, rows, widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  const cell = (text, w, opts = {}) =>
    new TableCell({
      width: { size: w, type: WidthType.DXA },
      shading: opts.head ? { type: ShadingType.CLEAR, fill: ACCENT } : undefined,
      margins: { top: 60, bottom: 60, left: 110, right: 110 },
      children: [
        new Paragraph({
          spacing: { after: 0 },
          alignment: opts.right ? AlignmentType.RIGHT : AlignmentType.LEFT,
          children: [
            new TextRun({
              text,
              bold: opts.head || opts.bold,
              color: opts.head ? 'FFFFFF' : undefined,
              size: 19,
              font: opts.mono ? MONO : undefined,
            }),
          ],
        }),
      ],
    });

  return new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((hd, i) => cell(hd, widths[i], { head: true, right: i > 0 && hd.startsWith('~') })),
      }),
      ...rows.map(
        (r) =>
          new TableRow({
            children: r.map((c, i) => {
              const mono = typeof c === 'string' && /^[\d\s.,$%+−-]+$/.test(c) && i > 0;
              return cell(String(c).replace(/^~/, ''), widths[i], { right: mono, mono, bold: r.bold });
            }),
          })
      ),
    ],
  });
}

const spacer = () => new Paragraph({ text: '', spacing: { after: 120 } });

const doc = new Document({
  numbering: {
    config: [
      {
        reference: 'puces',
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: '•',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 420, hanging: 220 } } },
          },
        ],
      },
    ],
  },
  styles: { default: { document: { run: { font: 'Calibri', size: 21 } } } },
  sections: [
    {
      properties: { page: { margin: { top: 1100, bottom: 1100, left: 1100, right: 1100 } } },
      children: [
        new Paragraph({
          spacing: { after: 60 },
          children: [new TextRun({ text: 'Arvon — tracking de performance', bold: true, size: 40, color: ACCENT })],
        }),
        p('Récapitulatif et décision à prendre — ' + new Date().toLocaleDateString('fr-FR'), {
          italics: true, color: '666666', size: 20, after: 320,
        }),

        // ---------------------------------------------------------------
        h1('1. Le constat'),

        p(
          'Sur un match réel, tu estimes avoir perdu 62 %. Arvon affiche −8 %. ' +
          'Après vérification sur la blockchain, les deux chiffres sont exacts. ' +
          'Ils ne mesurent simplement pas la même chose.'
        ),

        table(
          ['', '~Avant', '~Après', '~Delta'],
          [
            ['SOL dépensable', '0,005866', '0,000768', '−0,005098'],
            ['SOL en caution', '0,037358', '0,038872', '+0,001514'],
            Object.assign(['Equity totale', '5,084 $', '4,683 $', '−7,9 %'], { bold: true }),
          ],
          [3100, 1900, 1900, 1900]
        ),
        spacer(),

        p('Les 0,005098 SOL sortis de ton solde dépensable se décomposent ainsi :'),
        ...code([
          '0.001514 SOL  ->  caution d\'un nouveau casier (récupérable)',
          '0.003584 SOL  ->  réellement perdu (trade + frais)',
          '',
          'perte / capital dépensable :  0.003584 / 0.005866  =  -61 %',
          'perte / patrimoine total   :  0.401 $  / 5.084 $   =  -7.9 %',
        ]),

        p(
          'Sur Solana, chaque token occupe un compte dédié qui immobilise environ 0,0015 SOL de caution. ' +
          'Tu as une vingtaine de comptes vides, restes de trades passés : 4,57 $ immobilisés sur un ' +
          'patrimoine de 4,68 $. Ce capital ne bouge jamais, mais il est au dénominateur. ' +
          'Il écrase tous tes pourcentages d’un facteur 6,8.'
        ),

        // ---------------------------------------------------------------
        h1('2. La vraie question'),

        quote(
          'Ce qui cloche n’est pas le calcul. Il est juste, et il est prouvable ligne par ligne. ' +
          'Ce qui cloche, c’est ce qu’on a choisi de mesurer — et ça, c’est une décision, pas un bug.'
        ),

        p(
          'Un pourcentage n’a aucun sens tant qu’on n’a pas dit « pourcentage de quoi ». ' +
          'Arvon n’a jamais tranché cette question. Chaque « bug » depuis le début est un symptôme de ' +
          'cette décision manquante : tant qu’elle n’est pas prise, on corrigera indéfiniment des ' +
          'écarts entre ce que la plateforme calcule et ce que le joueur ressent.'
        ),

        p('Il y a trois définitions possibles, et elles donnent trois jeux différents.', { bold: true }),

        h2('A — Performance du patrimoine  (ce qui tourne aujourd’hui)'),
        p('Tout ce que tu possèdes compte, y compris les cautions immobilisées.'),
        ...bullets([
          'Simple, honnête, impossible à contourner en cachant des actifs.',
          'Mais détenir un memecoin qui pompe fait gagner sans avoir tradé.',
          'Et le capital mort dilue le score : 500 casiers vides = score quasi figé, imbattable et incapable de gagner. C’est exploitable.',
        ]),

        h2('B — Performance du capital exposé  (correctif proposé)'),
        p('Seul compte ce qui est réellement soumis au marché : SOL dépensable et tokens.'),
        ...bullets([
          'Correspond à l’intuition du joueur : ton match aurait affiché −61 %.',
          'Ouvrir une position reste neutre, car la caution est traitée comme un transfert.',
          'Petit changement, effet immédiat.',
          'Mais détenir passivement un token qui monte fait toujours gagner.',
        ]),

        h2('C — Performance du trading pendant le match'),
        p('Seules comptent les positions ouvertes pendant le match. Le reste du portefeuille est ignoré.'),
        ...bullets([
          'C’est la seule définition qui mesure vraiment « qui trade le mieux ».',
          'Un joueur qui ne fait rien marque exactement 0, quoi qu’il détienne.',
          'Mais elle exige une lecture fiable des transactions — qui ne fonctionne pas actuellement (cf. section 4).',
          'Et elle soulève une question : que faire de quelqu’un qui vend une position antérieure au match ?',
        ]),

        h2('Ma recommandation'),
        p(
          'Passer en B maintenant : c’est une modification courte, elle règle ton écart immédiat et ' +
          'elle supprime la faille des casiers vides. Puis viser C comme cible réelle, une fois la lecture ' +
          'des transactions réparée. B est un bon jeu ; C est le jeu que tu décris quand tu parles d’Arvon.'
        ),

        // ---------------------------------------------------------------
        h1('3. Le correctif technique'),

        p('Aujourd’hui, la caution entre dans l’equity — c’est ce qui dilue :'),
        ...code([
          '// lib/performance.js',
          'if (snapshot.rent && snapshot.rent.amount > 0) {',
          '  push(HOLDING_RENT, SOL_MINT, snapshot.rent.amount, { ... });',
          '}',
        ]),

        p('Le correctif ne la supprime pas : il la sort du dénominateur et neutralise ses variations comme un flux.'),
        ...code([
          '// equity = SOL dépensable + tokens   (la caution n\'y est plus)',
          '',
          '// et la variation de caution devient un flux neutralisé,',
          '// exactement comme un dépôt ou un retrait externe :',
          'const fluxCaution = rentActuelle - rentPrecedente;',
          'flows.push({ type: \'RENT_LOCK\', usdValue: fluxCaution });',
        ]),

        p(
          'Le résultat : ouvrir un casier ne coûte rien au score, fermer un casier ne rapporte rien, ' +
          'et le dénominateur ne contient plus que le capital réellement en jeu. La formule elle-même ' +
          'ne change pas.'
        ),
        ...code([
          'performancePct = ((equityFinale / equityInitiale) - 1) * 100',
        ]),

        // ---------------------------------------------------------------
        h1('4. Deux bugs à corriger d’abord'),

        p(
          'Le premier est bloquant pour l’option C, et il est invisible : il échoue en silence.',
          { bold: true }
        ),
        ...bullets([
          'Transactions version 1 illisibles. La bibliothèque @solana/web3.js installée (1.95.3) ne sait désérialiser ni la version 0 que le réseau refuse désormais, ni la version 1 qu’il émet. La détection des transferts externes est donc totalement inactive en production. Correction : parsing tolérant signature par signature, ou montée de version de la bibliothèque.',
          'RPC public saturé. Les lots de 40 signatures renvoient des erreurs 429. Correction : lots plus petits, étalement dans le temps, ou fournisseur RPC dédié.',
        ]),

        // ---------------------------------------------------------------
        h1('5. Une idée que je n’avais pas encore soulevée'),

        p(
          'Deux joueurs avec des portefeuilles très différents ne jouent pas au même jeu, et aucune ' +
          'correction de code n’y changera quoi que ce soit.'
        ),

        table(
          ['Portefeuille', '~Coût d’une position ouverte'],
          [
            ['5 $', '≈ 3 %'],
            ['500 $', '≈ 0,03 %'],
            ['50 000 $', '≈ 0,0003 %'],
          ],
          [4400, 4400]
        ),
        spacer(),

        p(
          'Les frais Solana sont fixes en valeur absolue, donc leur poids relatif explose quand le ' +
          'portefeuille est petit. Un joueur à 5 $ part avec un handicap structurel de plusieurs points ' +
          'de pourcentage dès qu’il ouvre une position. À l’inverse, un gros portefeuille bouge très peu ' +
          'en pourcentage : il est presque impossible pour lui de faire un gros score.'
        ),

        p('Trois pistes, à trancher aussi :', { bold: true }),
        ...bullets([
          'Imposer un capital minimum pour entrer en match classé.',
          'Ne matcher que des joueurs de taille de portefeuille comparable.',
          'Accepter l’écart, mais le rendre visible dans l’interface pour que personne ne crie au bug.',
        ]),

        // ---------------------------------------------------------------
        h1('6. À trancher'),

        ...bullets([
          'Arvon mesure A, B ou C ? (recommandation : B maintenant, C comme cible)',
          'Faut-il un capital minimum, ou un matchmaking par taille de portefeuille ?',
          'Un joueur 100 % en stablecoin a un score figé : stratégie valide ou exclusion du classement ?',
          'Actif non cotable : geler le score (comportement actuel) ou une autre règle ?',
        ]),

        p(
          'Le code est prêt à basculer sur B dès que tu le dis : c’est une vingtaine de lignes dans ' +
          'lib/performance.js et lib/playertracker.js, plus deux tests.',
          { italics: true }
        ),
      ],
    },
  ],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(OUT, buf);
  console.log(`Ecrit : ${OUT} (${(buf.length / 1024).toFixed(0)} Ko)`);
});
