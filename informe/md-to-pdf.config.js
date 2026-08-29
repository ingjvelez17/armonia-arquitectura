// Configuración para generar informe/INFORME.pdf desde INFORME.md
//
//   npx md-to-pdf --config-file informe/md-to-pdf.config.js informe/INFORME.md
//
// Se usa un archivo de configuración en lugar de banderas de línea de comandos
// porque así la maquetación queda versionada junto al informe y el PDF es
// reproducible por cualquiera que clone el repositorio.

const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  stylesheet: [path.join(__dirname, 'estilo-informe.css')],
  css: fs.readFileSync(path.join(__dirname, 'estilo-informe.css'), 'utf8'),
  body_class: ['informe'],
  marked_options: { headerIds: true, smartypants: false },
  pdf_options: {
    format: 'A4',
    margin: { top: '16mm', bottom: '15mm', left: '16mm', right: '16mm' },
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate:
      '<div style="width:100%;font-size:7.5pt;color:#8a97a3;' +
      'font-family:Segoe UI,sans-serif;padding:0 16mm;display:flex;' +
      'justify-content:space-between">' +
      '<span>Orquestando c&oacute;digos: la sinfon&iacute;a de los sistemas &middot; ' +
      'Juan Esteban V&eacute;lez Venegas</span>' +
      '<span class="pageNumber"></span></div>',
  },
  launch_options: { args: ['--no-sandbox'] },
};
