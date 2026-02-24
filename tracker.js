let tournamentIds=[];
let playerIndex;
let tournamentToIndex=[];
let playerInformation;
let decklist;
const POKEWALLET_API_KEY = "API_KEY"; // i need a better way to hide this

async function fetchTournamentIDs(limit,game,format){
    let tournamentIds=[];
    try {
        const response = await fetch(`https://play.limitlesstcg.com/api/tournaments/?limit=${limit}&game=${game}&format=${format}`);
        if(!response.ok){
            throw new Error('Network response not ok');
        }
        const tournaments = await response.json();
        for (let i = 0; i < limit; i++) {
            tournamentIds.push(tournaments[i].id);
        }
        return tournamentIds;
    }
    catch(error) {
        console.error('There was an error ', error);
        return [];
    }
}

async function findPlayerIndex(tournamentId, player) {
    let playerIndex;
    try {
        const response = await fetch(`https://play.limitlesstcg.com/api/tournaments/${tournamentId}/standings`);
        if(!response.ok){
            throw new Error('Network response not ok');
        }
        const standings = await response.json();
        for(let i = 0; i < standings.length; i++) { // theres probably a more efficient way to do this but i cant figure it out
            if (!(standings[i].player == player || standings[i].name == player) && i==standings.length-1) {
                playerIndex=-1;
            }
            if((standings[i].player == player || standings[i].name == player)) {
                playerIndex = i;
                break;
            }
        }
        return playerIndex;
    }
    catch(error) {
        console.error('There was an error ', error);
        return [];
    }
}

async function mapTournamentToIndex(player) {
    let tournamentToIndex=[];
    for(let i = 0; i < tournamentIds.length; i++) {
        if (await findPlayerIndex(tournamentIds[i],player) != -1) {
            tournamentToIndex.push([tournamentIds[i],await findPlayerIndex(tournamentIds[i],player)]);
        }
    }
    return tournamentToIndex;
}

async function fetchPlayerInformation(tournamentId, playerIndex) {
    try {
        const response = await fetch(`https://play.limitlesstcg.com/api/tournaments/${tournamentId}/standings`)
        if(!response.ok){
            throw new Error('Network response not ok');
        }
        const playerInformation = await response.json();
        return playerInformation[playerIndex];
    }
    catch(error) {
        console.error('There was an error ', error);
        return [];
    }
}

async function fetchCardInformation(set, collectionNumber) {
    let cardId = set+"_"+collectionNumber;
    try {
        const response = await fetch(`https://api.pokewallet.io/cards/${cardId}`, {method: 'GET', headers: {'X-API-Key': POKEWALLET_API_KEY, 'Content-Type': 'application/json'}});
        if(!response.ok){
            throw new Error('Network response not ok');
        }
        const cardInformation = await response.json();
        return cardInformation;
    }
    catch(error) {
        console.error('There was an error ', error);
        return [];
    }
}

// this does not work at all
async function fetchCardImage(set,collectionNumber) {
    let cardId = set+"_"+collectionNumber;
    try {
        const response = await fetch(`https://api.pokewallet.io/images/${cardId}`, {method: 'GET', headers: {'X-API-Key': POKEWALLET_API_KEY, 'Content-Type': 'application/json'}});
        if(!response.ok){
            throw new Error('Network response not ok');
        }
        const cardImage = await response.json();
        return cardImage;
    }
    catch(error) {
        console.error('There was an error ', error);
        return [];
    }
}

tournamentIds = await fetchTournamentIDs(10, "PTCG", "STANDARD");
tournamentToIndex = await mapTournamentToIndex("Poke Mopos");
playerInformation = await fetchPlayerInformation("699cd82ec9dc8186f760b370", 26);
decklist = playerInformation.decklist;
console.log(decklist);
let cardInformation = await fetchCardInformation("TWM","130");
console.log(cardInformation);
let cardImage = await fetchCardImage("TWM","130");
console.log(cardImage);