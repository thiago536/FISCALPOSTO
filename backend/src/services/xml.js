const { escapeXml, money, pad, onlyDigits, dhEmi } = require("../utils/fiscal");

function infNfe(emp, nfe, itens, chave) {
  const dh = dhEmi(nfe.emitido_em);
  const destDoc = onlyDigits(nfe.dest_doc);
  const destTag = destDoc.length === 11
    ? `<CPF>${destDoc}</CPF>`
    : `<CNPJ>${pad(destDoc, 14)}</CNPJ>`;

  const det = itens.map((it) => `
    <det nItem="${it.item}">
      <prod>
        <cProd>${escapeXml(it.codigo || it.item)}</cProd>
        <cEAN>SEM GTIN</cEAN>
        <xProd>${escapeXml(it.descricao)}</xProd>
        <NCM>${onlyDigits(it.ncm || "27101259")}</NCM>
        <CFOP>${onlyDigits(it.cfop || "5656")}</CFOP>
        <uCom>${escapeXml(it.unidade || "LT")}</uCom>
        <qCom>${Number(it.quantidade).toFixed(4)}</qCom>
        <vUnCom>${money(it.valor_unitario)}</vUnCom>
        <vProd>${money(it.valor_total)}</vProd>
        <cEANTrib>SEM GTIN</cEANTrib>
        <uTrib>${escapeXml(it.unidade || "LT")}</uTrib>
        <qTrib>${Number(it.quantidade).toFixed(4)}</qTrib>
        <vUnTrib>${money(it.valor_unitario)}</vUnTrib>
        <indTot>1</indTot>
        ${it.anp ? `<comb>
          <cProdANP>${escapeXml(it.anp)}</cProdANP>
          <descANP>${escapeXml(it.desc_anp || it.descricao)}</descANP>
          <UFCons>${escapeXml(it.uf_consumo || nfe.dest_uf || emp.uf)}</UFCons>
        </comb>` : ""}
      </prod>
      <imposto>
        <ICMS>
          <ICMS${it.icms_cst === "60" ? "60" : "00"}>
            <orig>0</orig>
            <CST>${escapeXml(it.icms_cst || "00")}</CST>
            ${it.icms_cst === "60" ? "" : `
            <modBC>3</modBC>
            <vBC>${money(it.icms_base)}</vBC>
            <pICMS>${money(it.icms_aliq)}</pICMS>
            <vICMS>${money(it.icms_valor)}</vICMS>`}
          </ICMS${it.icms_cst === "60" ? "60" : "00"}>
        </ICMS>
        <PIS><PISOutr><CST>49</CST><qBCProd>0</qBCProd><vAliqProd>0.00</vAliqProd><vPIS>0.00</vPIS></PISOutr></PIS>
        <COFINS><COFINSOutr><CST>49</CST><qBCProd>0</qBCProd><vAliqProd>0.00</vAliqProd><vCOFINS>0.00</vCOFINS></COFINSOutr></COFINS>
      </imposto>
    </det>`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe Id="NFe${chave}" versao="4.00">
    <ide>
      <cUF>${emp.cuf}</cUF>
      <cNF>${chave.slice(35, 43)}</cNF>
      <natOp>${escapeXml(nfe.natureza || "VENDA DE COMBUSTIVEL")}</natOp>
      <mod>55</mod>
      <serie>${nfe.serie}</serie>
      <nNF>${nfe.numero}</nNF>
      <dhEmi>${dh}</dhEmi>
      <tpNF>1</tpNF>
      <idDest>1</idDest>
      <cMunFG>${emp.cmun || "3550308"}</cMunFG>
      <tpImp>1</tpImp>
      <tpEmis>1</tpEmis>
      <cDV>${chave.slice(-1)}</cDV>
      <tpAmb>${nfe.ambiente}</tpAmb>
      <finNFe>1</finNFe>
      <indFinal>1</indFinal>
      <indPres>1</indPres>
      <procEmi>0</procEmi>
      <verProc>PostoFiscal 1.0</verProc>
    </ide>
    <emit>
      <CNPJ>${pad(onlyDigits(emp.cnpj), 14)}</CNPJ>
      <xNome>${escapeXml(emp.razao_social)}</xNome>
      <xFant>${escapeXml(emp.nome_fantasia || emp.razao_social)}</xFant>
      <enderEmit>
        <xLgr>${escapeXml(emp.logradouro || "NAO INFORMADO")}</xLgr>
        <nro>${escapeXml(emp.numero || "S/N")}</nro>
        <xBairro>${escapeXml(emp.bairro || "CENTRO")}</xBairro>
        <cMun>${emp.cmun || "3550308"}</cMun>
        <xMun>${escapeXml(emp.municipio || "")}</xMun>
        <UF>${emp.uf}</UF>
        <CEP>${pad(onlyDigits(emp.cep || "00000000"), 8)}</CEP>
        <cPais>1058</cPais>
        <xPais>BRASIL</xPais>
      </enderEmit>
      <IE>${escapeXml(emp.ie || "ISENTO")}</IE>
      <CRT>${emp.crt}</CRT>
    </emit>
    <dest>
      ${destTag}
      <xNome>${escapeXml(nfe.dest_nome)}</xNome>
      <enderDest>
        <xLgr>${escapeXml(nfe.dest_endereco || "NAO INFORMADO")}</xLgr>
        <nro>S/N</nro>
        <xBairro>CENTRO</xBairro>
        <cMun>${"3550308"}</cMun>
        <xMun>${escapeXml(nfe.dest_municipio || emp.municipio || "")}</xMun>
        <UF>${escapeXml(nfe.dest_uf || emp.uf)}</UF>
        <cPais>1058</cPais>
        <xPais>BRASIL</xPais>
      </enderDest>
      <indIEDest>9</indIEDest>
    </dest>
    ${det}
    <total>
      <ICMSTot>
        <vBC>${money(itens.reduce((s, i) => s + Number(i.icms_base || 0), 0))}</vBC>
        <vICMS>${money(itens.reduce((s, i) => s + Number(i.icms_valor || 0), 0))}</vICMS>
        <vICMSDeson>0.00</vICMSDeson>
        <vFCP>0.00</vFCP>
        <vBCST>0.00</vBCST>
        <vST>0.00</vST>
        <vFCPST>0.00</vFCPST>
        <vFCPSTRet>0.00</vFCPSTRet>
        <vProd>${money(nfe.total_produtos)}</vProd>
        <vFrete>0.00</vFrete>
        <vSeg>0.00</vSeg>
        <vDesc>0.00</vDesc>
        <vII>0.00</vII>
        <vIPI>0.00</vIPI>
        <vIPIDevol>0.00</vIPIDevol>
        <vPIS>0.00</vPIS>
        <vCOFINS>0.00</vCOFINS>
        <vOutro>0.00</vOutro>
        <vNF>${money(nfe.total_nota)}</vNF>
      </ICMSTot>
    </total>
    <transp><modFrete>9</modFrete></transp>
    <pag>
      <detPag>
        <tPag>01</tPag>
        <vPag>${money(nfe.total_nota)}</vPag>
      </detPag>
    </pag>
  </infNFe>
</NFe>`;
}

function infCte(emp, cte, chave) {
  const dh = dhEmi(cte.emitido_em);
  return `<?xml version="1.0" encoding="UTF-8"?>
<CTe xmlns="http://www.portalfiscal.inf.br/cte">
  <infCte Id="CTe${chave}" versao="4.00">
    <ide>
      <cUF>${emp.cuf}</cUF>
      <cCT>${chave.slice(35, 43)}</cCT>
      <CFOP>${escapeXml(cte.cfop || "5353")}</CFOP>
      <natOp>${escapeXml(cte.natureza || "PRESTACAO DE SERVICO DE TRANSPORTE")}</natOp>
      <mod>57</mod>
      <serie>${cte.serie}</serie>
      <nCT>${cte.numero}</nCT>
      <dhEmi>${dh}</dhEmi>
      <tpImp>1</tpImp>
      <tpEmis>1</tpEmis>
      <cDV>${chave.slice(-1)}</cDV>
      <tpAmb>${cte.ambiente}</tpAmb>
      <tpCTe>0</tpCTe>
      <procEmi>0</procEmi>
      <verProc>PostoFiscal 1.0</verProc>
      <cMunEnv>${emp.cmun || "3550308"}</cMunEnv>
      <xMunEnv>${escapeXml(emp.municipio || "")}</xMunEnv>
      <UFEnv>${emp.uf}</UFEnv>
      <modal>01</modal>
      <tpServ>0</tpServ>
      <cMunIni>3550308</cMunIni>
      <xMunIni>${escapeXml(cte.rem_municipio || "")}</xMunIni>
      <UFIni>${escapeXml(cte.rem_uf || emp.uf)}</UFIni>
      <cMunFim>3550308</cMunFim>
      <xMunFim>${escapeXml(cte.dest_municipio || "")}</xMunFim>
      <UFFim>${escapeXml(cte.dest_uf || emp.uf)}</UFFim>
    </ide>
    <emit>
      <CNPJ>${pad(onlyDigits(emp.cnpj), 14)}</CNPJ>
      <IE>${escapeXml(emp.ie || "ISENTO")}</IE>
      <xNome>${escapeXml(emp.razao_social)}</xNome>
    </emit>
    <rem>
      <CNPJ>${pad(onlyDigits(cte.rem_doc), 14)}</CNPJ>
      <xNome>${escapeXml(cte.rem_nome)}</xNome>
    </rem>
    <dest>
      <CNPJ>${pad(onlyDigits(cte.dest_doc), 14)}</CNPJ>
      <xNome>${escapeXml(cte.dest_nome)}</xNome>
    </dest>
    <vPrest>
      <vTPrest>${money(cte.valor_servico)}</vTPrest>
      <vRec>${money(cte.valor_servico)}</vRec>
    </vPrest>
    <imp>
      <ICMS>
        <ICMS00>
          <CST>00</CST>
          <vBC>${money(cte.icms_base)}</vBC>
          <pICMS>${money(cte.icms_aliq)}</pICMS>
          <vICMS>${money(cte.icms_valor)}</vICMS>
        </ICMS00>
      </ICMS>
    </imp>
    <infCTeNorm>
      <infCarga>
        <vCarga>${money(cte.valor_servico)}</vCarga>
        <proPred>${escapeXml(cte.carga || "COMBUSTIVEL")}</proPred>
      </infCarga>
    </infCTeNorm>
  </infCte>
</CTe>`;
}

function infMdfe(emp, mdfe, condutores, percurso, docs, ciot, chave) {
  const dh = dhEmi(mdfe.emitido_em);
  const condXml = condutores.map((c) => `<condutor><xNome>${escapeXml(c.nome)}</xNome><CPF>${onlyDigits(c.cpf)}</CPF></condutor>`).join("");
  const percXml = percurso.map((p) => `<infPercurso><UFPer>${escapeXml(p.uf)}</UFPer></infPercurso>`).join("");
  const docsXml = docs.map((d) => d.tipo === "cte"
    ? `<infCTe><chCTe>${d.chave}</chCTe></infCTe>`
    : `<infNFe><chNFe>${d.chave}</chNFe></infNFe>`).join("");
  const ciotXml = ciot ? `
      <infANTT>
        <RNTRC>${escapeXml(mdfe.rntrc || "")}</RNTRC>
        <infCIOT>
          <CIOT>${escapeXml(String(ciot.numero).slice(0, 12))}</CIOT>
          <CPF>${onlyDigits(ciot.motorista_cpf || "00000000000")}</CPF>
        </infCIOT>
        <infPag>
          <xNome>${escapeXml(ciot.contratante_nome)}</xNome>
          <CNPJ>${pad(onlyDigits(ciot.contratante_doc), 14)}</CNPJ>
          <vContrato>${money(ciot.valor_contrato)}</vContrato>
          <indPag>1</indPag>
          ${ciot.chave_pix ? `<PIX>${escapeXml(ciot.chave_pix)}</PIX>` : ""}
        </infPag>
      </infANTT>` : `<infANTT><RNTRC>${escapeXml(mdfe.rntrc || "")}</RNTRC></infANTT>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<MDFe xmlns="http://www.portalfiscal.inf.br/mdfe">
  <infMDFe Id="MDFe${chave}" versao="3.00">
    <ide>
      <cUF>${emp.cuf}</cUF>
      <tpAmb>${mdfe.ambiente}</tpAmb>
      <tpEmit>1</tpEmit>
      <mod>58</mod>
      <serie>${mdfe.serie}</serie>
      <nMDF>${mdfe.numero}</nMDF>
      <cMDF>${chave.slice(35, 43)}</cMDF>
      <cDV>${chave.slice(-1)}</cDV>
      <modal>1</modal>
      <dhEmi>${dh}</dhEmi>
      <tpEmis>1</tpEmis>
      <procEmi>0</procEmi>
      <verProc>PostoFiscal 1.0</verProc>
      <UFIni>${escapeXml(mdfe.uf_ini)}</UFIni>
      <UFFim>${escapeXml(mdfe.uf_fim)}</UFFim>
      ${percXml}
    </ide>
    <emit>
      <CNPJ>${pad(onlyDigits(emp.cnpj), 14)}</CNPJ>
      <IE>${escapeXml(emp.ie || "ISENTO")}</IE>
      <xNome>${escapeXml(emp.razao_social)}</xNome>
    </emit>
    <infModal versaoModal="3.00">
      <rodo>
        ${ciotXml}
        <veicTracao>
          <placa>${escapeXml(mdfe.placa)}</placa>
          <UF>${escapeXml(mdfe.uf_veiculo || emp.uf)}</UF>
          ${condXml}
        </veicTracao>
      </rodo>
    </infModal>
    <infDoc>
      <infMunDescarga>
        <cMunDescarga>3550308</cMunDescarga>
        <xMunDescarga>${escapeXml(emp.municipio || "")}</xMunDescarga>
        ${docsXml}
      </infMunDescarga>
    </infDoc>
    <tot>
      <qCTe>${docs.filter((d) => d.tipo === "cte").length}</qCTe>
      <qNFe>${docs.filter((d) => d.tipo === "nfe").length}</qNFe>
      <vCarga>${money(mdfe.valor_carga)}</vCarga>
      <cUnid>01</cUnid>
      <qCarga>0.0000</qCarga>
    </tot>
  </infMDFe>
</MDFe>`;
}

module.exports = { infNfe, infCte, infMdfe };
