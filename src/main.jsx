import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { profiles } from './profiles'
import './styles.css'

const blank = { title:'', authors:'', abstract:'', keywords:'', introduction:'', methods:'', results:'', discussion:'', conclusion:'', references:'' }
const count = (text='') => (text.trim().match(/\S+/g)||[]).length

function splitSections(text) {
  const sections={...blank}
  const heading=/(^|\n)(TITLE|AUTHORS?|ABSTRACT|KEYWORDS?|INTRODUCTION|METHODS?|MATERIALS AND METHODS|RESULTS?|DISCUSSION|CONCLUSIONS?|REFERENCES?|BIBLIOGRAPHY)[\s.:*-]*\n/gi
  const matches=[...text.matchAll(heading)]
  if(!matches.length){sections.introduction=text;return sections}
  const before=text.slice(0,matches[0].index).trim()
  if(before){const lines=before.split('\n').map(x=>x.trim()).filter(Boolean);sections.title=lines.shift()||'';if(lines.length)sections.authors=lines.join(', ')}
  matches.forEach((match,i)=>{
    const name=match[2].toUpperCase(),start=match.index+match[0].length,end=i+1<matches.length?matches[i+1].index:text.length,value=text.slice(start,end).replace(/^\n+/, '').trim()
    if(/^ABSTRACT/.test(name))sections.abstract=value
    else if(/^KEYWORD/.test(name))sections.keywords=value
    else if(/^INTRO/.test(name))sections.introduction=value
    else if(/^METHOD/.test(name)||/^MATERIALS/.test(name))sections.methods=value
    else if(/^RESULT/.test(name))sections.results=value
    else if(/^DISCUSS/.test(name))sections.discussion=value
    else if(/^CONCLUSION/.test(name))sections.conclusion=value
    else if(/^REFERENCE/.test(name)||/^BIBLIO/.test(name))sections.references=value
  })
  return sections
}

async function extractDocument(file){
  if(/\.docx$/i.test(file.name)){const mammoth=await import('mammoth');const result=await mammoth.extractRawText({arrayBuffer:await file.arrayBuffer()});return result.value}
  if(/\.pdf$/i.test(file.name)){const pdfjs=await import('pdfjs-dist');pdfjs.GlobalWorkerOptions.workerSrc=`https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;const pdf=await pdfjs.getDocument({data:await file.arrayBuffer()}).promise;const pages=[];for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i);const content=await page.getTextContent();pages.push(content.items.map(item=>item.str).join(' '))}return pages.join('\n')}
  return file.text()
}

function App(){
  const [profile,setProfile]=useState('Nature'),[manuscript,setManuscript]=useState(blank),[tab,setTab]=useState('document'),[fileName,setFileName]=useState(''),[status,setStatus]=useState(''),[drag,setDrag]=useState(false)
  const input=useRef(),p=profiles[profile]
  const fields=[['title','Manuscript title'],['authors','Authors'],['abstract','Abstract'],['keywords','Keywords'],['introduction','Introduction'],['methods','Methods'],['results','Results'],['discussion','Discussion'],['conclusion','Conclusion'],['references','References']]
  const total=fields.reduce((sum,[key])=>sum+count(manuscript[key]),0)
  const warnings=[]
  if(!manuscript.title)warnings.push('Manuscript title was not detected.')
  if(!manuscript.abstract)warnings.push('Abstract was not detected.')
  if(count(manuscript.abstract)>p.abstract)warnings.push(`Abstract is ${count(manuscript.abstract)} words; ${p.abstract} is the profile limit.`)
  if(!manuscript.references.trim())warnings.push('References were not detected.')

  async function upload(file){
    if(!file)return
    if(!/(\.docx|\.pdf|\.txt|\.tex)$/i.test(file.name)){setStatus('Please upload DOCX, PDF, TXT, or TEX.');return}
    setStatus('Reading manuscript…')
    try{const text=await extractDocument(file);setManuscript(splitSections(text));setFileName(file.name);setStatus(`Imported ${file.name}`);setTab('sections')}catch(error){setStatus(`Could not read this document: ${error.message}`)}
  }
  const update=(key,value)=>setManuscript(current=>({...current,[key]:value}))

  function download(type){
    const title=manuscript.title||'Untitled Manuscript',body=`Title: ${title}\nAuthors: ${manuscript.authors}\n\nAbstract\n${manuscript.abstract}\n\nKeywords\n${manuscript.keywords}\n\nIntroduction\n${manuscript.introduction}\n\nMethods\n${manuscript.methods}\n\nResults\n${manuscript.results}\n\nDiscussion\n${manuscript.discussion}\n\nConclusion\n${manuscript.conclusion}\n\nReferences\n${manuscript.references}`
    let content=body,mime='text/plain;charset=utf-8',extension='txt'
    if(type==='tex'){content=`\\documentclass[12pt]{article}\n\\usepackage[margin=${(p.margin/25.4).toFixed(2)}in]{geometry}\n\\title{${title}}\n\\begin{document}\n\\maketitle\n\\begin{abstract}\n${manuscript.abstract}\n\\end{abstract}\n\\section*{Introduction}\n${manuscript.introduction}\n\\section*{Methods}\n${manuscript.methods}\n\\section*{Results}\n${manuscript.results}\n\\section*{Discussion}\n${manuscript.discussion}\n\\section*{Conclusion}\n${manuscript.conclusion}\n\\section*{References}\n${manuscript.references}\n\\end{document}`;mime='application/x-tex';extension='tex'}
    const url=URL.createObjectURL(new Blob([content],{type:mime})),a=document.createElement('a');a.href=url;a.download=`${title.replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'')||'manuscript'}.${extension}`;a.click();URL.revokeObjectURL(url)
  }

  async function downloadDocx(){const {Document,Packer,Paragraph,HeadingLevel,TextRun}=await import('docx'),children=[];children.push(new Paragraph({alignment:'center',children:[new TextRun({text:manuscript.title||'Untitled Manuscript',bold:true,size:p.size*2})]}));if(manuscript.authors)children.push(new Paragraph({alignment:'center',text:manuscript.authors}));[['Abstract',manuscript.abstract],['Keywords',manuscript.keywords],['Introduction',manuscript.introduction],['Methods',manuscript.methods],['Results',manuscript.results],['Discussion',manuscript.discussion],['Conclusion',manuscript.conclusion],['References',manuscript.references]].forEach(([heading,text])=>{if(text){children.push(new Paragraph({text:heading,heading:HeadingLevel.HEADING_1}));text.split(/\n+/).filter(Boolean).forEach(line=>children.push(new Paragraph(line)))}});const doc=new Document({sections:[{properties:{},children}]});const blob=await Packer.toBlob(doc),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='formatted-manuscript.docx';a.click();URL.revokeObjectURL(url)}

  async function downloadPdf(){const {jsPDF}=await import('jspdf'),pdf=new jsPDF({unit:'mm',format:'a4'}),margin=p.margin;pdf.setFont(p.font==='Arial'?'helvetica':'times','normal');pdf.setFontSize(p.size);let y=margin;const write=(text,bold=false)=>{pdf.setFont(undefined,bold?'bold':'normal');pdf.splitTextToSize(text||'',210-margin*2).forEach(line=>{if(y>297-margin){pdf.addPage();y=margin}pdf.text(line,margin,y);y+=p.spacing*5})};write(manuscript.title||'Untitled Manuscript',true);y+=5;[['Abstract',manuscript.abstract],['Keywords',manuscript.keywords],['Introduction',manuscript.introduction],['Methods',manuscript.methods],['Results',manuscript.results],['Discussion',manuscript.discussion],['Conclusion',manuscript.conclusion],['References',manuscript.references]].forEach(([heading,text])=>{if(text){write(heading,true);y+=2;write(text);y+=5}});pdf.save('formatted-manuscript.pdf')}

  return <main>
    <header><div className="brand"><span className="mark">M</span><div><h1>Manuscript Formatter</h1><p>Journal-ready formatting, without the busywork.</p></div></div><span className="badge">OPEN SOURCE · PRIVATE BY DEFAULT</span></header>
    <section className="hero"><div><p className="eyebrow">RESEARCH AUTHOR WORKSPACE</p><h2>Format once.<br/><em>Submit with confidence.</em></h2><p className="intro">Upload your complete manuscript and prepare a journal-ready structure.</p></div><div className="journal-card"><label>PUBLISHER / JOURNAL</label><select value={profile} onChange={e=>setProfile(e.target.value)}>{Object.keys(profiles).map(x=><option key={x}>{x}</option>)}</select><div className="specs"><span>{p.publisher}</span><span>{p.font} {p.size} pt</span><span>{p.style}</span></div></div></section>
    <nav><button className={tab==='document'?'active':''} onClick={()=>setTab('document')}>Upload document</button><button className={tab==='sections'?'active':''} onClick={()=>setTab('sections')}>Edit sections</button><button className={tab==='review'?'active':''} onClick={()=>setTab('review')}>Review <b>{warnings.length}</b></button></nav>
    {tab==='document'&&<section className="panel"><div className={`dropzone ${drag?'drag':''}`} onDragOver={e=>{e.preventDefault();setDrag(true)}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);upload(e.dataTransfer.files[0])}} onClick={()=>input.current.click()}><input ref={input} type="file" accept=".docx,.pdf,.txt,.tex" onChange={e=>upload(e.target.files[0])}/><span className="upload-icon">↑</span><strong>{fileName||'Drop your manuscript here'}</strong><small>DOCX, PDF, TXT or LaTeX</small><button type="button">Choose document</button></div>{status&&<p className="status">{status}</p>}</section>}
    {tab==='sections'&&<section className="panel editor"><div className="wordbar"><div><strong>{total.toLocaleString()}</strong><span> manuscript words</span></div><div><strong>{count(manuscript.abstract)}</strong><span> / {p.abstract} abstract words</span></div></div>{fields.map(([key,label])=><label key={key}>{label.toUpperCase()}<textarea className={key==='title'||key==='authors'||key==='keywords'?'short':''} value={manuscript[key]} onChange={e=>update(key,e.target.value)} placeholder={`Add ${label.toLowerCase()}...`}/><small>{count(manuscript[key])} words</small></label>)}<div className="actions"><button onClick={()=>download('txt')}>Export TXT</button><button onClick={downloadDocx}>Export DOCX</button><button onClick={downloadPdf}>Export PDF</button><button onClick={()=>download('tex')}>Export LaTeX</button></div></section>}
    {tab==='review'&&<section className="panel checklist"><h3>Submission readiness</h3>{warnings.length?warnings.map((w,i)=><div className="warning" key={i}><span>!</span>{w}</div>):<div className="success">✓ Your manuscript meets the detected profile checks.</div>}<div className="profile"><strong>{profile}</strong><span>{p.publisher} · {total.toLocaleString()} total words · Abstract {count(manuscript.abstract)} / {p.abstract} · {p.font} {p.size} pt · {p.margin} mm margins</span></div><div className="actions"><button onClick={()=>setTab('sections')}>Edit sections</button><button className="primary" onClick={downloadDocx}>Export formatted DOCX</button></div></section>}
    <footer><span>Built for researchers · Files stay in your browser</span><span>{Object.keys(profiles).length} publisher presets</span></footer>
  </main>
}

createRoot(document.getElementById('root')).render(<App />)
