// Firestore security-rules tests for ../firestore.rules, run against the emulator:
//   npm run rules        (from tests/; needs Java 11+)
// Every case starts from the same seeded database (SEED below), so cases are
// independent. To add one, append to CASES: [name, uid, (db) => write/read, allowed?]
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  doc, setDoc, updateDoc, getDoc, getDocs, addDoc, collection, query, where,
  arrayUnion, serverTimestamp, runTransaction, setLogLevel, deleteField, deleteDoc
} from 'firebase/firestore';

setLogLevel('silent'); // expected denials otherwise print noisy gRPC errors

const rules = readFileSync(fileURLToPath(new URL('../firestore.rules', import.meta.url)), 'utf8');

// ---------- seed data ----------
// uids: adm=admin, sa=superadmin, brd=board, rb=resident with boardMember flag,
//       r1/r2=residents, pend=resident awaiting approval
const SEED = {
  'users/adm': { role: 'admin', approved: true },
  'users/sa': { role: 'superadmin', approved: true },
  'users/brd': { role: 'board', approved: true },
  'users/rb': { role: 'resident', boardMember: true, approved: true },
  'users/r1': { role: 'resident', approved: true },
  'users/r2': { role: 'resident', approved: true },
  'users/pend': { role: 'resident', approved: false },
  'bills/b1': { uid: 'r1', amount: 2500, status: 'unpaid' },
  'bills/b2': { uid: 'r2', amount: 2500, status: 'unpaid', isDeleted: true },
  'bills/bs': { uid: 'r1', amount: 2500, status: 'submitted' },
  'bills/b3': { uid: 'r2', amount: 2500, status: 'unpaid' },
  'bills/bi': { uid: 'r1', amount: 2500, status: 'unpaid', proofData: 'old' },
  'proofs/pr1': { uid: 'r1', kind: 'bill', data: 'x' },
  'proofs/pr2': { uid: 'r2', kind: 'bill', data: 'y' },
  'polls/pc': { question: 'Q', createdBy: 'adm', votes: { r1: 0 }, closed: true },
  'polls/p1': { question: 'Q', createdBy: 'adm', votes: { r2: 0 } },
  'polls/p0': { question: 'Q', createdBy: 'adm' },
  'polls/pe': { question: 'Q', createdBy: 'adm', votes: {} },
  'decisions/d1': { title: 'T', status: 'pending', votes: [] },
  'decisions/dq': { title: 'T', status: 'pending', votes: [{ uid: 'a', choice: 'endorse' }, { uid: 'b', choice: 'endorse' }] },
  'decisions/ds': { title: 'T', status: 'pending', votes: [{ uid: 'a', choice: 'endorse' }] },
  'decisions/dn': { title: 'T' },
  'decisions/dm': { title: 'T', type: 'membership', refUid: 'pend', status: 'pending', requiredVotes: 2, votes: [{ uid: 'adm', choice: 'endorse' }] },
  'volunteer_programs/v1': { title: 'V', participants: [] },
  'volunteer_programs/v2': { title: 'V', participants: [{ uid: 'r1' }] },
  'expenses/x1': { title: 'Paint', amount: 100, createdBy: 'adm' },
  'client_errors/ce1': { uid: 'r1', message: 'boom', kind: 'error' },
  'transfers/tr1': { amount: 100 },
  'monthly_summaries/2026-09': { collected: 1 },
  'settings/society': { bank: 'HBL' },
  'funds/f1': { title: 'Masjid' },
  'announcements/n1': { title: 'N', createdBy: 'brd', allowComments: true },
  'announcements/ne': { title: 'E', createdBy: 'adm', emergency: true },
  'announcements/nr1': { title: 'Fire at House 3', createdBy: 'r1', emergency: true, alertAll: true, createdByRole: 'resident' },
  'settings/emergencyContacts': { contacts: [{ label: 'Gate', phone: '15' }] },
  'settings/usefulContacts': { services: [], contacts: [] },
  'tickets/t1': { uid: 'r1', status: 'pending' },
  'tickets/td': { uid: 'r1', status: 'resolved', history: [] },
  'tickets/td2': { uid: 'r2', status: 'closed' },
  'documents/doc1': { title: 'Bylaws', createdBy: 'adm' },
  'documents/docb': { title: 'Form', createdBy: 'brd' },
  'listings/lr1': { title: 'Cat', kind: 'lost', createdBy: 'r1', status: 'open' },
  'listings/lr2': { title: 'Bike', kind: 'sell', createdBy: 'r2', status: 'open' },
  'listings/lrc': { title: 'Cot', kind: 'sell', createdBy: 'r1', status: 'closed' },
  'listings/lrd': { title: 'Old', kind: 'sell', createdBy: 'r1', status: 'open', isDeleted: true },
  'fund_contributions/fc1': { uid: 'r1', fundId: 'f1', amount: 500, status: 'verified' },
  'proofs/lstf': { uid: 'r2', kind: 'listing', data: 'x' },
  'proofs/docf': { uid: 'adm', kind: 'document', data: 'pdf' },
  'meetings/m1': { title: 'M', status: 'upcoming', suggestionsOpen: true, agenda: [{ text: 'a', byUid: 'adm', source: 'board' }], createdBy: 'adm' },
  'meetings/mc': { title: 'M', status: 'upcoming', suggestionsOpen: false, agenda: [], createdBy: 'adm' },
  'meetings/mh': { title: 'M', status: 'held', agenda: [], minutes: 'x', createdBy: 'adm' }
};

// ---------- cases: [name, signed-in uid, action(db), should be allowed] ----------
const CASES = [
  // Bills
  ['resident submits proof for own bill', 'r1', db => updateDoc(doc(db, 'bills/b1'), { status: 'submitted', proofData: 'x' }), true],
  ['resident cannot touch another bill', 'r1', db => updateDoc(doc(db, 'bills/b2'), { status: 'submitted' }), false],
  ['admin edits bill amount', 'adm', db => updateDoc(doc(db, 'bills/b1'), { amount: 3000 }), true],
  ['admin approves proof -> paid', 'adm', db => updateDoc(doc(db, 'bills/bs'), { status: 'paid', paidAt: serverTimestamp(), verifiedBy: 'A' }), true],
  ['super admin restores deleted bill', 'sa', db => updateDoc(doc(db, 'bills/b2'), { isDeleted: false, restoredAt: new Date(), restoredBy: 'SA' }), true],
  ['super admin cannot change bill amount', 'sa', db => updateDoc(doc(db, 'bills/b1'), { amount: 1 }), false],
  ['resident reads own bill', 'r1', db => getDoc(doc(db, 'bills/b1')), true],
  ['resident cannot read another bill', 'r1', db => getDoc(doc(db, 'bills/b3')), false],
  ['resident lists own bills', 'r1', db => getDocs(query(collection(db, 'bills'), where('uid', '==', 'r1'))), true],
  ['resident cannot list all bills', 'r1', db => getDocs(collection(db, 'bills')), false],
  ['board lists all bills', 'brd', db => getDocs(collection(db, 'bills')), true],
  ['resident submits proof by proofId', 'r1', db => updateDoc(doc(db, 'bills/bi'), { status: 'submitted', proofId: 'pr1', proofData: deleteField(), proofBatch: 'pr1' }), true],
  ['admin adds late fee', 'adm', db => updateDoc(doc(db, 'bills/b1'), { amount: 2800, baseAmount: 2500, lateFee: 300, lateFeeApplied: true }), true],
  ['resident cannot change amount', 'r1', db => updateDoc(doc(db, 'bills/b1'), { status: 'submitted', amount: 1 }), false],

  // Proof files
  ['resident stores own proof', 'r1', db => addDoc(collection(db, 'proofs'), { uid: 'r1', kind: 'bill', data: 'x' }), true],
  ['resident cannot store proof as another', 'r1', db => addDoc(collection(db, 'proofs'), { uid: 'r2', kind: 'bill', data: 'x' }), false],
  ['resident reads own proof', 'r1', db => getDoc(doc(db, 'proofs/pr1')), true],
  ['resident cannot read another proof', 'r1', db => getDoc(doc(db, 'proofs/pr2')), false],
  ['board reads a proof', 'brd', db => getDoc(doc(db, 'proofs/pr2')), true],
  ['admin moves an old proof for a resident', 'adm', db => addDoc(collection(db, 'proofs'), { uid: 'r2', kind: 'bill', data: 'x' }), true],
  ['resident cannot edit a stored proof', 'r1', db => updateDoc(doc(db, 'proofs/pr1'), { data: 'z' }), false],

  // Settings
  ['board updates bills summary', 'brd', db => setDoc(doc(db, 'settings/billsSummary'), { paidTotal: 1 }), true],
  ['resident cannot write bills summary', 'r1', db => setDoc(doc(db, 'settings/billsSummary'), { paidTotal: 1 }), false],
  ['resident reads bills summary', 'r1', db => getDoc(doc(db, 'settings/billsSummary')), true],
  ['board cannot write other settings', 'brd', db => setDoc(doc(db, 'settings/backup'), { lastAt: 1 }), false],
  ['admin records backup time', 'adm', db => setDoc(doc(db, 'settings/backup'), { lastAt: serverTimestamp() }, { merge: true }), true],

  // Notifications
  ['resident notifies admin', 'r1', db => addDoc(collection(db, 'users/adm/notifications'), { title: 'x' }), true],
  ['resident notifies board', 'r1', db => addDoc(collection(db, 'users/brd/notifications'), { title: 'x' }), true],
  ['resident cannot notify another resident', 'r1', db => addDoc(collection(db, 'users/r2/notifications'), { title: 'x' }), false],
  ['admin notifies resident', 'adm', db => addDoc(collection(db, 'users/r2/notifications'), { title: 'x' }), true],
  ['board notifies resident', 'brd', db => addDoc(collection(db, 'users/r2/notifications'), { title: 'x' }), true],
  ['board-flag resident notifies resident', 'rb', db => addDoc(collection(db, 'users/r1/notifications'), { title: 'x' }), true],

  // Users
  ['super admin reads a user', 'sa', db => getDoc(doc(db, 'users/r1')), true],
  ['resident cannot list admins', 'r1', db => getDocs(query(collection(db, 'users'), where('role', '==', 'admin'))), false],
  ['board lists admins (notifyAdmins)', 'brd', db => getDocs(query(collection(db, 'users'), where('role', '==', 'admin'))), true],
  ['board-flag resident lists admins', 'rb', db => getDocs(query(collection(db, 'users'), where('role', '==', 'admin'))), true],
  ['board-flag resident lists approved users (broadcast)', 'rb', db => getDocs(query(collection(db, 'users'), where('approved', '==', true))), true],
  ['board cannot approve a user', 'brd', db => updateDoc(doc(db, 'users/r2'), { approved: true }), false],
  ['board cannot apply membership outcome', 'brd', db => updateDoc(doc(db, 'users/pend'), { approved: true, membershipStatus: 'approved', statusReason: '' }), false],

  // Polls
  ['resident votes in poll', 'r1', db => updateDoc(doc(db, 'polls/p1'), { votes: { r2: 0, r1: 1 } }), true],
  ['resident votes in poll with no votes field', 'r1', db => updateDoc(doc(db, 'polls/p0'), { votes: { r1: 0 } }), true],
  ['resident votes via transaction', 'r1', db => runTransaction(db, async tx => {
    const ref = doc(db, 'polls/pe'); const v = (await tx.get(ref)).data().votes || {}; v.r1 = 1; tx.update(ref, { votes: v });
  }), true],
  ['resident changes their vote', 'r2', db => updateDoc(doc(db, 'polls/p1'), { votes: { r2: 1 } }), true],
  ['resident cannot change another vote', 'r1', db => updateDoc(doc(db, 'polls/p1'), { votes: { r2: 1, r1: 0 } }), false],
  ['resident cannot vote in a closed poll', 'r1', db => updateDoc(doc(db, 'polls/pc'), { votes: { r1: 1 } }), false],
  ['resident cannot edit poll question', 'r2', db => updateDoc(doc(db, 'polls/p1'), { question: 'hacked' }), false],

  // Board decisions
  ['board appends own vote', 'brd', db => updateDoc(doc(db, 'decisions/d1'), { votes: [{ uid: 'brd', choice: 'endorse' }] }), true],
  ['board cannot fake another vote', 'brd', db => updateDoc(doc(db, 'decisions/d1'), { votes: [{ uid: 'brd', choice: 'endorse' }, { uid: 'x', choice: 'endorse' }] }), false],
  ['board cannot edit decision title', 'brd', db => updateDoc(doc(db, 'decisions/d1'), { title: 'z' }), false],
  ['board quorum vote finalizes', 'brd', db => updateDoc(doc(db, 'decisions/dq'), { votes: [{ uid: 'a', choice: 'endorse' }, { uid: 'b', choice: 'endorse' }, { uid: 'brd', choice: 'endorse', reason: '', votedAt: 'x', name: 'B' }], status: 'approved', finalizedAt: serverTimestamp() }), true],
  ['board membership vote finalizes', 'brd', db => updateDoc(doc(db, 'decisions/dm'), { votes: [{ uid: 'adm', choice: 'endorse' }, { uid: 'brd', choice: 'endorse' }], status: 'approved', finalizedAt: serverTimestamp() }), true],
  ['board-flag resident votes', 'rb', db => updateDoc(doc(db, 'decisions/ds'), { votes: [{ uid: 'a', choice: 'endorse' }, { uid: 'rb', choice: 'reject' }] }), true],
  ['board stale vote (list missing a vote) rejected', 'brd', db => updateDoc(doc(db, 'decisions/dq'), { votes: [{ uid: 'a', choice: 'endorse' }, { uid: 'brd', choice: 'endorse' }] }), false],
  ['board votes on decision without status/votes', 'brd', db => updateDoc(doc(db, 'decisions/dn'), { votes: [{ uid: 'brd', choice: 'endorse' }] }), true],
  ['super admin reads decisions', 'sa', db => getDoc(doc(db, 'decisions/d1')), true],

  // Volunteers
  ['resident joins program', 'r1', db => updateDoc(doc(db, 'volunteer_programs/v1'), { participants: arrayUnion({ uid: 'r1' }) }), true],
  ['resident leaves program', 'r1', db => updateDoc(doc(db, 'volunteer_programs/v2'), { participants: [] }), true],
  ['resident cannot rename program', 'r1', db => updateDoc(doc(db, 'volunteer_programs/v1'), { title: 'z' }), false],

  // Announcements
  ['resident comments on a notice', 'r1', db => addDoc(collection(db, 'announcements/n1/comments'), { uid: 'r1', text: 'hi', name: 'R', role: 'resident', createdAt: serverTimestamp() }), true],

  // Tickets
  ['admin updates ticket', 'adm', db => updateDoc(doc(db, 'tickets/t1'), { status: 'resolved', department: 'x' }), true],
  ['board lodges own complaint', 'brd', db => addDoc(collection(db, 'tickets'), { uid: 'brd', status: 'pending' }), true],
  ['admin lodges own complaint', 'adm', db => addDoc(collection(db, 'tickets'), { uid: 'adm', status: 'pending' }), true],
  ['admin cannot lodge complaint in a resident\'s name', 'adm', db => addDoc(collection(db, 'tickets'), { uid: 'r1', status: 'pending' }), false],
  ['board reads all tickets', 'brd', db => getDocs(collection(db, 'tickets')), true],
  ['resident lodges complaint with photos + history', 'r1', db => addDoc(collection(db, 'tickets'), { uid: 'r1', status: 'pending', photoIds: ['x'], history: [{ status: 'pending' }] }), true],
  ['resident stores a complaint photo', 'r1', db => addDoc(collection(db, 'proofs'), { uid: 'r1', kind: 'ticket', data: 'x' }), true],
  ['resident rates own resolved complaint', 'r1', db => updateDoc(doc(db, 'tickets/td'), { rating: { stars: 4, comment: 'ok', at: 1 }, history: arrayUnion({ status: 'resolved', note: 'Rated 4/5' }), updatedAt: serverTimestamp() }), true],
  ['resident cannot rate a pending complaint', 'r1', db => updateDoc(doc(db, 'tickets/t1'), { rating: { stars: 4, comment: '', at: 1 } }), false],
  ['resident cannot rate another resident complaint', 'r1', db => updateDoc(doc(db, 'tickets/td2'), { rating: { stars: 1, comment: '', at: 1 } }), false],
  ['resident cannot give 6 stars', 'r1', db => updateDoc(doc(db, 'tickets/td'), { rating: { stars: 6, comment: '', at: 1 } }), false],
  ['resident reopens own resolved complaint', 'r1', db => updateDoc(doc(db, 'tickets/td'), { status: 'pending', history: arrayUnion({ status: 'pending', note: 'Reopened' }), updatedAt: serverTimestamp(), reopenedAt: serverTimestamp(), reopenCount: 1 }), true],
  ['resident cannot mark own complaint resolved', 'r1', db => updateDoc(doc(db, 'tickets/t1'), { status: 'resolved' }), false],
  ['resident cannot change department while rating', 'r1', db => updateDoc(doc(db, 'tickets/td'), { rating: { stars: 5, comment: '', at: 1 }, department: 'X' }), false],
  ['admin adds note to history', 'adm', db => updateDoc(doc(db, 'tickets/t1'), { status: 'in-progress', department: 'Plumbing', history: arrayUnion({ status: 'in-progress', note: 'n' }), updatedAt: serverTimestamp() }), true],

  // Documents vault
  ['resident reads documents', 'r1', db => getDocs(collection(db, 'documents')), true],
  ['resident reads a document file', 'r1', db => getDoc(doc(db, 'proofs/docf')), true],
  ['resident still cannot read another resident\'s proof', 'r1', db => getDoc(doc(db, 'proofs/pr2')), false],
  ['pending resident cannot read documents', 'pend', db => getDocs(collection(db, 'documents')), false],
  ['resident cannot add a document', 'r1', db => addDoc(collection(db, 'documents'), { title: 'X', createdBy: 'r1' }), false],
  ['admin adds a document', 'adm', db => addDoc(collection(db, 'documents'), { title: 'X', createdBy: 'adm' }), true],
  ['board adds a document', 'brd', db => addDoc(collection(db, 'documents'), { title: 'X', createdBy: 'brd' }), true],
  ['board cannot add a document as someone else', 'brd', db => addDoc(collection(db, 'documents'), { title: 'X', createdBy: 'adm' }), false],
  ['board edits own document', 'brd', db => updateDoc(doc(db, 'documents/docb'), { title: 'Y' }), true],
  ['board cannot edit admin\'s document', 'brd', db => updateDoc(doc(db, 'documents/doc1'), { title: 'Y' }), false],
  ['super admin archives a document', 'sa', db => updateDoc(doc(db, 'documents/doc1'), { isDeleted: true }), true],
  ['admin cannot hard-delete a document', 'adm', db => deleteDoc(doc(db, 'documents/doc1')), false],

  // lost & found / classifieds
  ['resident reads listings', 'r1', db => getDocs(collection(db, 'listings')), true],
  ['pending resident cannot read listings', 'pend', db => getDocs(collection(db, 'listings')), false],
  ['resident posts a listing in own name', 'r1', db => addDoc(collection(db, 'listings'), { title: 'X', kind: 'sell', createdBy: 'r1' }), true],
  ['resident cannot post a listing as someone else', 'r1', db => addDoc(collection(db, 'listings'), { title: 'X', kind: 'sell', createdBy: 'r2' }), false],
  ['pending resident cannot post a listing', 'pend', db => addDoc(collection(db, 'listings'), { title: 'X', createdBy: 'pend' }), false],
  ['admin posts a listing', 'adm', db => addDoc(collection(db, 'listings'), { title: 'X', kind: 'found', createdBy: 'adm' }), true],
  ['resident closes own listing', 'r1', db => updateDoc(doc(db, 'listings/lr1'), { status: 'closed' }), true],
  ['resident cannot edit another resident\'s listing', 'r1', db => updateDoc(doc(db, 'listings/lr2'), { title: 'Y' }), false],
  ['board moderates (removes) a listing', 'brd', db => updateDoc(doc(db, 'listings/lr2'), { isDeleted: true }), true],
  ['admin moderates (removes) a listing', 'adm', db => updateDoc(doc(db, 'listings/lr1'), { isDeleted: true }), true],
  ['resident cannot hard-delete a listing', 'r1', db => deleteDoc(doc(db, 'listings/lr1')), false],
  ['resident reads another resident\'s listing photo', 'r1', db => getDoc(doc(db, 'proofs/lstf')), true],
  ['pending resident cannot read a listing photo', 'pend', db => getDoc(doc(db, 'proofs/lstf')), false],

  // Board meetings: agenda & minutes
  ['resident reads meetings', 'r1', db => getDocs(collection(db, 'meetings')), true],
  ['resident cannot create a meeting', 'r1', db => addDoc(collection(db, 'meetings'), { title: 'X', createdBy: 'r1' }), false],
  ['board creates a meeting', 'brd', db => addDoc(collection(db, 'meetings'), { title: 'X', createdBy: 'brd', status: 'upcoming', agenda: [] }), true],
  ['admin publishes minutes', 'adm', db => updateDoc(doc(db, 'meetings/m1'), { status: 'held', minutes: 'done', decisions: [], suggestionsOpen: false }), true],
  ['resident suggests an agenda item', 'r1', db => updateDoc(doc(db, 'meetings/m1'), { agenda: arrayUnion({ text: 'b', byUid: 'r1', source: 'resident' }), updatedAt: serverTimestamp() }), true],
  ['resident cannot suggest in another\'s name', 'r1', db => updateDoc(doc(db, 'meetings/m1'), { agenda: arrayUnion({ text: 'b', byUid: 'r2', source: 'resident' }), updatedAt: serverTimestamp() }), false],
  ['resident cannot pose as a board item', 'r1', db => updateDoc(doc(db, 'meetings/m1'), { agenda: arrayUnion({ text: 'b', byUid: 'r1', source: 'board' }), updatedAt: serverTimestamp() }), false],
  ['resident cannot remove agenda items', 'r1', db => updateDoc(doc(db, 'meetings/m1'), { agenda: [], updatedAt: serverTimestamp() }), false],
  ['resident cannot suggest when suggestions are closed', 'r1', db => updateDoc(doc(db, 'meetings/mc'), { agenda: arrayUnion({ text: 'b', byUid: 'r1', source: 'resident' }), updatedAt: serverTimestamp() }), false],
  ['resident cannot suggest on a held meeting', 'r1', db => updateDoc(doc(db, 'meetings/mh'), { agenda: arrayUnion({ text: 'b', byUid: 'r1', source: 'resident' }), updatedAt: serverTimestamp() }), false],
  ['resident cannot edit minutes', 'r1', db => updateDoc(doc(db, 'meetings/mh'), { minutes: 'tampered' }), false],

  // Emergency broadcast + contacts
  ['admin sends an emergency broadcast', 'adm', db => addDoc(collection(db, 'announcements'), { title: 'Fire', content: 'x', emergency: true, emergencyType: 'fire', createdBy: 'adm', createdAt: serverTimestamp() }), true],
  ['superadmin sends an emergency broadcast', 'sa', db => addDoc(collection(db, 'announcements'), { title: 'Fire', content: 'x', emergency: true, createdBy: 'sa', createdAt: serverTimestamp() }), true],
  ['board sends an emergency alarm', 'brd', db => addDoc(collection(db, 'announcements'), { title: 'Fire', content: 'x', emergency: true, createdBy: 'brd', createdAt: serverTimestamp() }), true],
  ['board still posts a normal notice', 'brd', db => addDoc(collection(db, 'announcements'), { title: 'N', content: 'x', createdBy: 'brd', createdAt: serverTimestamp() }), true],
  ['resident raises an emergency alarm for everyone', 'r1', db => addDoc(collection(db, 'announcements'), { title: 'Fire at House 3', content: 'x', emergency: true, emergencyType: 'fire', allowComments: false, alertAll: true, createdBy: 'r1', createdByName: 'R', createdByRole: 'resident', createdByHouse: 'H3', createdAt: serverTimestamp() }), true],
  ['resident cannot raise an alarm as someone else', 'r1', db => addDoc(collection(db, 'announcements'), { title: 'Fire', emergency: true, alertAll: true, createdBy: 'r2' }), false],
  ['pending resident cannot raise an alarm', 'pend', db => addDoc(collection(db, 'announcements'), { title: 'Fire', emergency: true, alertAll: true, createdBy: 'pend' }), false],
  ['resident cannot post a normal notice', 'r1', db => addDoc(collection(db, 'announcements'), { title: 'Sale', content: 'x', createdBy: 'r1' }), false],
  ['nobody sends a normal notice to everyone via alertAll', 'adm', db => addDoc(collection(db, 'announcements'), { title: 'N', content: 'x', alertAll: true, createdBy: 'adm' }), false],
  ['resident cannot raise an already-resolved alarm', 'r1', db => addDoc(collection(db, 'announcements'), { title: 'Fire', emergency: true, createdBy: 'r1', resolvedAt: new Date() }), false],
  ['resident cancels own alarm', 'r1', db => updateDoc(doc(db, 'announcements/nr1'), { resolvedAt: serverTimestamp(), resolvedBy: 'R' }), true],
  ['resident cannot edit own alarm text', 'r1', db => updateDoc(doc(db, 'announcements/nr1'), { title: 'changed' }), false],
  ['resident cannot cancel another resident alarm', 'r2', db => updateDoc(doc(db, 'announcements/nr1'), { resolvedAt: serverTimestamp(), resolvedBy: 'X' }), false],
  ['admin resolves a resident alarm', 'adm', db => updateDoc(doc(db, 'announcements/nr1'), { resolvedAt: serverTimestamp(), resolvedBy: 'A' }), true],
  ['resident stops the alarm for themselves', 'r2', db => setDoc(doc(db, 'announcements/nr1/acks/r2'), { at: serverTimestamp(), name: 'R2' }), true],
  ['resident cannot stop the alarm for someone else', 'r2', db => setDoc(doc(db, 'announcements/nr1/acks/r1'), { at: serverTimestamp() }), false],
  ['pending resident cannot ack an alarm', 'pend', db => setDoc(doc(db, 'announcements/nr1/acks/pend'), { at: serverTimestamp() }), false],
  ['resident cannot delete own alarm', 'r1', db => deleteDoc(doc(db, 'announcements/nr1')), false],
  ['superadmin resolves an emergency', 'sa', db => updateDoc(doc(db, 'announcements/ne'), { resolvedAt: serverTimestamp(), resolvedBy: 'S' }), true],
  ['resident cannot resolve an emergency', 'r1', db => updateDoc(doc(db, 'announcements/ne'), { resolvedAt: serverTimestamp() }), false],
  ['resident reads emergency contacts', 'r1', db => getDoc(doc(db, 'settings/emergencyContacts')), true],
  ['superadmin edits emergency contacts', 'sa', db => setDoc(doc(db, 'settings/emergencyContacts'), { contacts: [{ label: 'Gate', phone: '1' }], updatedAt: serverTimestamp() }, { merge: true }), true],
  ['admin edits emergency contacts', 'adm', db => setDoc(doc(db, 'settings/emergencyContacts'), { contacts: [] }, { merge: true }), true],
  ['board cannot edit emergency contacts', 'brd', db => setDoc(doc(db, 'settings/emergencyContacts'), { contacts: [] }, { merge: true }), false],
  ['resident reads useful contacts', 'r1', db => getDoc(doc(db, 'settings/usefulContacts')), true],
  ['pending resident cannot read useful contacts', 'pend', db => getDoc(doc(db, 'settings/usefulContacts')), false],
  ['superadmin edits useful contacts', 'sa', db => setDoc(doc(db, 'settings/usefulContacts'), { services: [], contacts: [] }), true],
  ['admin edits useful contacts', 'adm', db => setDoc(doc(db, 'settings/usefulContacts'), { services: [], contacts: [] }), true],
  ['board cannot edit useful contacts', 'brd', db => setDoc(doc(db, 'settings/usefulContacts'), { services: [], contacts: [] }), false],
  ['resident cannot edit useful contacts', 'r1', db => setDoc(doc(db, 'settings/usefulContacts'), { services: [], contacts: [] }), false],
  ['resident cannot edit emergency contacts', 'r1', db => setDoc(doc(db, 'settings/emergencyContacts'), { contacts: [] }, { merge: true }), false],
  ['resident cannot change the title while suggesting', 'r1', db => updateDoc(doc(db, 'meetings/m1'), { title: 'Z', agenda: arrayUnion({ text: 'b', byUid: 'r1', source: 'resident' }) }), false],

  // Audit log
  ['audit entry as self', 'r1', db => addDoc(collection(db, 'audit_log'), { performedByUid: 'r1' }), true],
  ['audit entry as admin', 'adm', db => addDoc(collection(db, 'audit_log'), { performedByUid: 'adm' }), true],
  ['audit entry as someone else', 'r1', db => addDoc(collection(db, 'audit_log'), { performedByUid: 'adm' }), false],
  // ---- approval gating on community reads (A8) ----
  ['approved resident reads announcements', 'r1', db => getDocs(collection(db, 'announcements')), true],
  ['pending resident cannot read announcements', 'pend', db => getDocs(collection(db, 'announcements')), false],
  ['pending resident cannot read polls', 'pend', db => getDocs(collection(db, 'polls')), false],
  ['pending resident cannot read expenses', 'pend', db => getDoc(doc(db, 'expenses/x1')), false],
  ['approved resident reads expenses', 'r2', db => getDoc(doc(db, 'expenses/x1')), true],
  ['pending resident cannot read transfers', 'pend', db => getDoc(doc(db, 'transfers/tr1')), false],
  ['pending resident cannot read monthly summaries', 'pend', db => getDoc(doc(db, 'monthly_summaries/2026-09')), false],
  ['board reads monthly summaries', 'brd', db => getDoc(doc(db, 'monthly_summaries/2026-09')), true],
  ['pending resident cannot read society settings', 'pend', db => getDoc(doc(db, 'settings/society')), false],
  ['approved resident reads society settings', 'r1', db => getDoc(doc(db, 'settings/society')), true],
  ['pending resident cannot read funds', 'pend', db => getDoc(doc(db, 'funds/f1')), false],
  ['pending resident can still read own profile', 'pend', db => getDoc(doc(db, 'users/pend')), true],
  // ---- report export log ownership (A5) ----
  ['resident logs own export', 'r1', db => addDoc(collection(db, 'report_exports'), { reportType: 'statement', generatedByUid: 'r1', fileName: 'a.pdf' }), true],
  ['resident cannot log an export as someone else', 'r1', db => addDoc(collection(db, 'report_exports'), { reportType: 'statement', generatedByUid: 'r2', fileName: 'a.pdf' }), false],
  ['export log without generatedByUid is rejected', 'adm', db => addDoc(collection(db, 'report_exports'), { reportType: 'finance_report', fileName: 'a.pdf' }), false],
  ['pending resident cannot log an export', 'pend', db => addDoc(collection(db, 'report_exports'), { reportType: 'statement', generatedByUid: 'pend' }), false],
  // ---- client error reports (B7) ----
  ['resident reports an error as themselves', 'r1', db => addDoc(collection(db, 'client_errors'), { uid: 'r1', message: 'TypeError: x', kind: 'error' }), true],
  ['pending resident can report an error too', 'pend', db => addDoc(collection(db, 'client_errors'), { uid: 'pend', message: 'permission', kind: 'console' }), true],
  ['cannot report an error under another uid', 'r1', db => addDoc(collection(db, 'client_errors'), { uid: 'r2', message: 'x', kind: 'error' }), false],
  ['error report without uid is rejected', 'r1', db => addDoc(collection(db, 'client_errors'), { message: 'x', kind: 'error' }), false],
  ['resident cannot read error reports', 'r1', db => getDoc(doc(db, 'client_errors/ce1')), false],
  ['board can read error reports', 'brd', db => getDoc(doc(db, 'client_errors/ce1')), true],
  ['admin can clear an error report', 'adm', db => deleteDoc(doc(db, 'client_errors/ce1')), true],
  ['superadmin can clear an error report', 'sa', db => deleteDoc(doc(db, 'client_errors/ce1')), true],
  ['board cannot clear error reports', 'brd', db => deleteDoc(doc(db, 'client_errors/ce1')), false],
  ['error reports cannot be edited', 'adm', db => updateDoc(doc(db, 'client_errors/ce1'), { message: 'changed' }), false],
  ['oversized error report is rejected', 'r1', db => addDoc(collection(db, 'client_errors'), { uid: 'r1', message: 'x'.repeat(301), kind: 'error' }), false],

  // ---- profile privilege escalation ----
  ['resident edits own profile details', 'r1', db => updateDoc(doc(db, 'users/r1'), { name: 'R', cnic: '1', phone: '0300', house: 'H1', family: [], mutedCategories: ['polls'] }), true],
  ['resident cannot make themselves super admin', 'r1', db => updateDoc(doc(db, 'users/r1'), { superAdmin: true }), false],
  ['resident cannot make themselves a board member', 'r1', db => updateDoc(doc(db, 'users/r1'), { boardMember: true }), false],
  ['resident cannot change own role', 'r1', db => updateDoc(doc(db, 'users/r1'), { role: 'admin' }), false],
  ['pending resident cannot approve themselves', 'pend', db => updateDoc(doc(db, 'users/pend'), { approved: true }), false],
  ['resident cannot exempt themselves from bills', 'r1', db => updateDoc(doc(db, 'users/r1'), { billExempt: true }), false],
  ['resident cannot set own membership status', 'pend', db => updateDoc(doc(db, 'users/pend'), { membershipStatus: 'approved' }), false],
  ['board-flag resident cannot make themselves super admin', 'rb', db => updateDoc(doc(db, 'users/rb'), { superAdmin: true }), false],
  ['new account registers', 'new1', db => setDoc(doc(db, 'users/new1'), { name: 'N', email: 'n@x', role: 'resident', house: 'H', phone: '0', approved: false, biodataSubmitted: false, createdAt: serverTimestamp() }), true],
  ['new account cannot register as super admin', 'new1', db => setDoc(doc(db, 'users/new1'), { name: 'N', role: 'resident', approved: false, superAdmin: true }), false],
  ['new account cannot register as board member', 'new1', db => setDoc(doc(db, 'users/new1'), { name: 'N', role: 'resident', approved: false, boardMember: true }), false],
  ['admin makes a resident a board member', 'adm', db => updateDoc(doc(db, 'users/r2'), { boardMember: true }), true],
  ['admin exempts a resident from bills', 'adm', db => updateDoc(doc(db, 'users/r2'), { billExempt: true, billExemptReason: 'x' }), true],

  // ---- bill proof submission only touches proof fields ----
  ['resident submits proof with method, date and ref', 'r1', db => updateDoc(doc(db, 'bills/b1'), { status: 'submitted', paymentMethod: 'bank', paymentDate: '2026-10-01', proofId: 'pr1', proofType: 'image', proofName: 'a.jpg', proofData: deleteField(), proofBatch: '', paymentRef: 'TX1', proofRejectedReason: '', proofUploadedAt: serverTimestamp() }), true],
  ['resident cannot archive own bill', 'r1', db => updateDoc(doc(db, 'bills/b1'), { status: 'submitted', isDeleted: true }), false],
  ['resident cannot change own bill period or due date', 'r1', db => updateDoc(doc(db, 'bills/b1'), { status: 'submitted', dueDate: '2030-01-01' }), false],
  ['resident cannot drop own late fee', 'r1', db => updateDoc(doc(db, 'bills/b1'), { status: 'submitted', lateFee: 0 }), false],

  // ---- pending accounts and community data ----
  ['pending resident cannot vote in a poll', 'pend', db => updateDoc(doc(db, 'polls/p1'), { votes: { r2: 0, pend: 1 } }), false],
  ['pending resident cannot read verified contributions', 'pend', db => getDoc(doc(db, 'fund_contributions/fc1')), false],
  ['resident reads verified contributions', 'r2', db => getDoc(doc(db, 'fund_contributions/fc1')), true],

  // ---- document files ----
  ['resident cannot store a file as a society document', 'r1', db => addDoc(collection(db, 'proofs'), { uid: 'r1', kind: 'document', data: 'x' }), false],
  ['board stores a document file', 'brd', db => addDoc(collection(db, 'proofs'), { uid: 'brd', kind: 'document', data: 'x' }), true],
  ['resident stores a listing photo', 'r1', db => addDoc(collection(db, 'proofs'), { uid: 'r1', kind: 'listing', data: 'x', type: 'image', name: 'a.jpg' }), true],

  // ---- listings: ownership, alerts, moderation ----
  ['resident posts a lost item with alert', 'r1', db => addDoc(collection(db, 'listings'), { title: 'Bag', kind: 'lost', createdBy: 'r1', status: 'open', alertAll: true, photoIds: [] }), true],
  ['resident cannot alert everyone for a sale', 'r1', db => addDoc(collection(db, 'listings'), { title: 'Bike', kind: 'sell', createdBy: 'r1', status: 'open', alertAll: true }), false],
  ['resident edits own listing', 'r1', db => updateDoc(doc(db, 'listings/lr1'), { title: 'Cat Milo', description: 'd', price: 0, location: 'Park', contactPhone: '0300', kind: 'lost', updatedAt: serverTimestamp() }), true],
  ['resident reopens own listing', 'r1', db => updateDoc(doc(db, 'listings/lrc'), { status: 'open', closedAt: null, updatedAt: serverTimestamp() }), true],
  ['resident deletes own listing', 'r1', db => updateDoc(doc(db, 'listings/lr1'), { isDeleted: true, deletedAt: serverTimestamp(), deletedBy: 'R', deletedByRole: 'owner' }), true],
  ['resident cannot hand own listing to someone else', 'r1', db => updateDoc(doc(db, 'listings/lr1'), { createdBy: 'r2' }), false],
  ['resident cannot re-send the alert', 'r1', db => updateDoc(doc(db, 'listings/lr1'), { alertAll: true }), false],
  ['resident cannot restore a removed listing', 'r1', db => updateDoc(doc(db, 'listings/lrd'), { isDeleted: false }), false],
  ['board cannot rewrite a resident listing', 'brd', db => updateDoc(doc(db, 'listings/lr2'), { title: 'Y' }), false],
  ['admin removes a listing with details', 'adm', db => updateDoc(doc(db, 'listings/lr2'), { isDeleted: true, deletedAt: serverTimestamp(), deletedBy: 'A', deletedByRole: 'admin' }), true],
];

// ---------- runner ----------
// Host/port come from FIRESTORE_EMULATOR_HOST, set by `firebase emulators:exec`.
const env = await initializeTestEnvironment({ projectId: 'rphs-test', firestore: { rules } });
let passed = 0, failed = 0;
for (const [name, uid, action, allowed] of CASES) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await Promise.all(Object.entries(SEED).map(([path, data]) => setDoc(doc(db, path), data)));
  });
  const db = env.authenticatedContext(uid).firestore();
  try {
    await (allowed ? assertSucceeds : assertFails)(action(db));
    passed++; console.log(`ok    ${name}`);
  } catch (e) {
    failed++; console.log(`FAIL  ${name}: expected ${allowed ? 'ALLOW' : 'DENY'}\n      ${String(e.message).split('\n')[0].slice(0, 200)}`);
  }
}
await env.cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
