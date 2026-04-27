const { PDFDocument } = PDFLib;

export class PDFEditor {
  constructor() {
    this.doc = null;
  }

  async load(arrayBuffer) {
    this.doc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
  }

  async applyFormData(formData) {
    let form;
    try { form = this.doc.getForm(); } catch { return; }

    for (const fields of Object.values(formData)) {
      for (const { fieldName, fieldType, value } of fields) {
        try {
          if (fieldType === 'Tx') {
            form.getTextField(fieldName).setText(value);
          } else if (fieldType === 'Btn') {
            const cb = form.getCheckBox(fieldName);
            value !== 'Off' ? cb.check() : cb.uncheck();
          } else if (fieldType === 'Ch') {
            form.getDropdown(fieldName).select(value);
          }
        } catch (err) {
          console.warn('Could not set field', fieldName, err.message);
        }
      }
    }
  }

  async applySignatures(placements) {
    for (const { pageNum, pdfX, pdfY, pdfW, pdfH, sigDataUrl } of placements) {
      const base64 = sigDataUrl.split(',')[1];
      const bytes  = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const image  = await this.doc.embedPng(bytes);
      const page   = this.doc.getPage(pageNum - 1);

      // pdfY is the top edge of the overlay in PDF coords (bottom-left origin).
      // pdf-lib drawImage uses bottom-left corner.
      page.drawImage(image, {
        x:      pdfX,
        y:      pdfY - pdfH,
        width:  pdfW,
        height: pdfH,
      });
    }
  }

  async getBytes() {
    return this.doc.save();
  }
}
