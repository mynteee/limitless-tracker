let tournamentIds=[];
let playerIndex;
let tournamentToIndex=[];

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

tournamentIds = await fetchTournamentIDs(10, "PTCG", "STANDARD");
tournamentToIndex = await mapTournamentToIndex("Poke Mopos");
// should return [['699cd82ec9dc8186f760b370, 26]]
console.log(tournamentIds);
console.log(tournamentToIndex);